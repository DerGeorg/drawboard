import { Signal, computed, signal } from '@angular/core';
import {
  EstimationEntry,
  EstimationItem,
  EstimationSession,
  EstimationSessionState,
} from '@apps/drawboard-api';

import { ApiError } from '../../../../util/api-error';
import {
  DEADLINE_JITTER_MS,
  EtagPoller,
  POLL_INTERVAL_MS,
  PollAnswer,
  PollEnd,
} from '../../../../util/etag-poller';

/** Magic MOVING: everyone may move every card, so the board is polled twice as often (E18). */
export const MOVING_INTERVAL_MS = 1_000;
/** How often the countdown of a phase ticks. */
export const TICK_MS = 1_000;

/** DONE and CANCELLED never change again. */
export function isClosed(state: EstimationSessionState): boolean {
  return state === EstimationSessionState.DONE || state === EstimationSessionState.CANCELLED;
}

/** The phases that run against a deadline (`phaseEndsAt`). */
export function isRunning(state: EstimationSessionState): boolean {
  return (
    state === EstimationSessionState.PLACING ||
    state === EstimationSessionState.MOVING ||
    state === EstimationSessionState.ROTATING
  );
}

/** Something this tab did that the next answers may not show yet (no version change, E3). */
interface Own<T> {
  version: number;
  state: EstimationSessionState;
  round: number;
  value: T;
}

export interface LeaseOptions {
  fetch(etag: string | undefined): Promise<PollAnswer<EstimationSession>>;
  /** Visibility source (the page's document); polling pauses while it is hidden. */
  doc?: Document;
  onUnauthorized?(error: ApiError): void;
  /** Every new state of the session (poll or operation): the board's list follows it. */
  onSession?(session: EstimationSession): void;
}

/**
 * ONE estimation session in this tab (shared by every component that shows it): an
 * `EtagPoller` (2 s, 1 s in Magic MOVING, paused while hidden, back-off on 429), the server's
 * clock (`serverTime`) for the countdown, and a poll within 0-500 ms after `phaseEndsAt` -
 * the server applies a due transition on the next request (E14, E18). Only the server clock
 * counts: the local clock only measures the time since the last answer.
 *
 * Keeps what this tab placed or entered until an answer with a newer version arrives: a
 * placement in PLACING and an own Rotation entry do not raise the version (E3), so the next
 * answers are 304s.
 */
export class EstimationLease {
  private readonly poller: EtagPoller<EstimationSession>;
  private readonly offset = signal(0);
  private readonly clock = signal(Date.now());
  private readonly placements = signal<ReadonlyMap<string, Own<string | null>>>(new Map());
  private readonly entries = signal<ReadonlyMap<string, Own<EstimationEntry>>>(new Map());
  private tick: ReturnType<typeof setInterval> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** The deadline a poll was already scheduled for (one poll per deadline). */
  private polledDeadline: string | undefined;

  /** The session as this tab knows it, with its own placements and entries. */
  readonly session: Signal<EstimationSession | undefined>;
  readonly end: Signal<PollEnd | undefined>;
  readonly retrying: Signal<boolean>;
  /** Milliseconds until `phaseEndsAt` by the server's clock; undefined without a deadline. */
  readonly remainingMs: Signal<number | undefined>;

  constructor(private readonly options: LeaseOptions) {
    this.poller = new EtagPoller<EstimationSession>({
      fetch: async (etag) => {
        const answer = await options.fetch(etag);
        if (answer.changed) {
          this.synchronise(answer.value);
        }
        return answer;
      },
      doc: options.doc,
      onUnauthorized: options.onUnauthorized,
      intervalMs: () =>
        this.poller.value()?.state === EstimationSessionState.MOVING
          ? MOVING_INTERVAL_MS
          : POLL_INTERVAL_MS,
      isNewer: (next, current) => next.version >= current.version,
      isFinal: (session) => isClosed(session.state),
    });
    this.end = this.poller.end;
    this.retrying = this.poller.retrying;
    this.session = computed(() => this.withOwn(this.poller.value()));
    this.remainingMs = computed(() => {
      const ends = this.poller.value()?.phaseEndsAt;
      const state = this.poller.value()?.state;
      if (!ends || !state || !isRunning(state)) {
        return undefined;
      }
      return Math.max(0, Date.parse(ends) - (this.clock() + this.offset()));
    });
  }

  get active(): boolean {
    return this.poller.active;
  }

  start(): void {
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
    clearInterval(this.tick);
    clearTimeout(this.deadlineTimer);
    this.tick = undefined;
    this.deadlineTimer = undefined;
  }

  /** Poll now (after an own action). */
  refresh(): void {
    this.poller.refresh();
  }

  /** An answer we got outside the poll (start, advance, finish, cancel): take it as the state. */
  accept(session: EstimationSession): void {
    this.synchronise(session);
    this.poller.accept(session);
  }

  /** The 204 of placeEstimationItem: our card sits in `value` now (null = taken out). */
  placed(itemId: string, value: string | null): void {
    const s = this.poller.value();
    if (s) {
      this.placements.update((m) =>
        new Map(m).set(itemId, { version: s.version, state: s.state, round: s.round, value }),
      );
    }
  }

  /** The 200 of setRotationEstimate: our entry for the card in this round. */
  entered(itemId: string, entry: EstimationEntry): void {
    const s = this.poller.value();
    if (s) {
      this.entries.update((m) =>
        new Map(m).set(itemId, {
          version: s.version,
          state: s.state,
          round: s.round,
          value: entry,
        }),
      );
    }
  }

  /** Reads the server clock of an answer before it is shown (no flicker of the countdown). */
  private synchronise(session: EstimationSession): void {
    const current = this.poller.value();
    if (current && session.version < current.version) {
      return; // an older answer: the poller drops it
    }
    const server = Date.parse(session.serverTime);
    if (Number.isFinite(server)) {
      this.clock.set(Date.now());
      this.offset.set(server - Date.now());
    }
    this.schedule(session);
    this.options.onSession?.(session);
  }

  /** The countdown and the poll at the deadline of `session`. */
  private schedule(session: EstimationSession): void {
    const ends = session.phaseEndsAt;
    if (!ends || !isRunning(session.state)) {
      clearInterval(this.tick);
      this.tick = undefined;
      return;
    }
    this.tick ??= setInterval(() => this.clock.set(Date.now()), TICK_MS);
    if (ends === this.polledDeadline) {
      return;
    }
    clearTimeout(this.deadlineTimer);
    const wait = Math.max(0, Date.parse(ends) - (Date.now() + this.offset()));
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined;
      this.polledDeadline = ends;
      this.clock.set(Date.now());
      this.poller.pollSoon(DEADLINE_JITTER_MS);
    }, wait);
  }

  /** The server's session with what this tab did since its version. */
  private withOwn(session: EstimationSession | undefined): EstimationSession | undefined {
    if (!session) {
      return undefined;
    }
    const current = <T>(own: Own<T> | undefined): own is Own<T> =>
      !!own &&
      own.version === session.version &&
      own.state === session.state &&
      own.round === session.round;
    const placements = this.placements();
    const entries = this.entries();
    if (placements.size === 0 && entries.size === 0) {
      return session;
    }
    let changed = false;
    const items = session.items.map((item): EstimationItem => {
      const placement = placements.get(item.id);
      const entry = entries.get(item.id);
      // PLACING: only own cards; MOVING: any card (every move raises the version)
      if (current(placement) && (item.mine || session.state === EstimationSessionState.MOVING)) {
        changed = true;
        return { ...item, column: placement.value ?? undefined };
      }
      if (current(entry) && item.mine) {
        changed = true;
        return { ...item, myEntry: entry.value };
      }
      return item;
    });
    return changed ? { ...session, items } : session;
  }
}
