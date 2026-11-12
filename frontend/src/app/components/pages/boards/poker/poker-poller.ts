import { computed, signal } from '@angular/core';
import { PokerRound, PokerRoundState } from '@apps/drawboard-api';

import { ApiError } from '../../../../util/api-error';

/** The contract's polling interval for an open estimation dialog. */
export const POLL_INTERVAL_MS = 2_000;
/** Longest wait between two polls after failures (network, 5xx, 429 without Retry-After). */
export const MAX_BACKOFF_MS = 30_000;

/** One answer of getPokerRound: a new state with its ETag, or "unchanged" (304). */
export type RoundAnswer = { changed: true; round: PokerRound; etag?: string } | { changed: false };

/** Fetches the round, sending `etag` as If-None-Match; rejects with an ApiError otherwise. */
export type FetchRound = (etag: string | undefined) => Promise<RoundAnswer>;

/** Why polling stopped for good: the round does not exist for us, or we may not see it. */
export type PollEnd = 'gone' | 'forbidden' | 'unauthorized';

export interface PollerOptions {
  fetch: FetchRound;
  /** Visibility source (the page's document); polling pauses while it is hidden. */
  doc?: Document;
  /** A 401: the app's usual handling (login, end of a guest session). */
  onUnauthorized?(error: ApiError): void;
  intervalMs?: number;
  maxBackoffMs?: number;
}

/**
 * Polls ONE planning poker round (contract `getPokerRound`): every 2 s after the previous
 * answer (never overlapping), with the last ETag in If-None-Match (304 = unchanged), backing off
 * on 429 (Retry-After) and on failures, paused while the tab is hidden, stopped when the round
 * is no longer OPEN or when `stop()` is called. Keeps the caller's own vote from the 204 of
 * castPokerVote (`voted`): a changed vote does not raise the round's version, so the next
 * answers are 304s and would leave an old `myVote`.
 */
export class PokerPoller {
  private readonly current = signal<PokerRound | undefined>(undefined);
  private readonly ended = signal<PollEnd | undefined>(undefined);
  private readonly ownVote = signal<string | undefined>(undefined);
  private readonly failing = signal(false);

  readonly round = this.current.asReadonly();
  readonly end = this.ended.asReadonly();
  /** True while the last poll failed (network, server, rate limit) and a retry is waiting. */
  readonly retrying = this.failing.asReadonly();
  /** The caller's vote: the one we cast in this tab, else the server's `myVote`. */
  readonly myVote = computed(() =>
    this.current()?.state === PokerRoundState.CANCELLED
      ? undefined
      : (this.ownVote() ?? this.current()?.myVote),
  );

  private etag: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight = false;
  private backoff = 0;
  private readonly interval: number;
  private readonly maxBackoff: number;
  private readonly onVisibility = (): void => {
    if (this.options.doc?.hidden) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (this.running && !this.inFlight && this.timer === undefined) {
      void this.poll();
    }
  };

  constructor(private readonly options: PollerOptions) {
    this.interval = options.intervalMs ?? POLL_INTERVAL_MS;
    this.maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  }

  get active(): boolean {
    return this.running;
  }

  /** Starts polling at once (no-op while running or after the round ended). */
  start(): void {
    if (this.running || this.ended()) {
      return;
    }
    this.running = true;
    this.options.doc?.addEventListener('visibilitychange', this.onVisibility);
    void this.poll();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.options.doc?.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Poll now instead of at the next tick (after an own vote, reveal or cancel). */
  refresh(): void {
    if (!this.running || this.inFlight) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.poll();
  }

  /** The 204 of castPokerVote: this is our vote now. */
  voted(value: string): void {
    this.ownVote.set(value);
  }

  /** An answer we got outside the poll (create, reveal, cancel): take it as the state. */
  accept(round: PokerRound): void {
    const before = this.current();
    if (!before || round.version >= before.version) {
      this.current.set(round);
    }
    if (round.state !== PokerRoundState.OPEN) {
      this.stop();
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || this.options.doc?.hidden) {
      return;
    }
    this.inFlight = true;
    let delay = this.interval;
    try {
      const answer = await this.options.fetch(this.etag);
      if (answer.changed) {
        this.etag = answer.etag ?? this.etag;
        this.accept(answer.round);
      }
      this.backoff = 0;
      this.failing.set(false);
    } catch (error) {
      delay = this.failed(error);
    } finally {
      this.inFlight = false;
    }
    if (this.running && !this.options.doc?.hidden) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.poll();
      }, delay);
    }
  }

  /** Handles a failed poll; returns how long to wait before the next one. */
  private failed(error: unknown): number {
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 304) {
      this.backoff = 0;
      this.failing.set(false);
      return this.interval; // unchanged: keep the same If-None-Match
    }
    if (status === 401 || status === 403 || status === 404) {
      this.ended.set(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'gone');
      this.stop();
      if (status === 401 && error instanceof ApiError) {
        this.options.onUnauthorized?.(error);
      }
      return this.interval;
    }
    this.failing.set(true);
    this.backoff = Math.min(
      this.maxBackoff,
      this.backoff === 0 ? this.interval * 2 : this.backoff * 2,
    );
    if (status === 429 && error instanceof ApiError) {
      const seconds = Number(error.response.headers?.get('Retry-After'));
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, 5 * 60_000);
      }
    }
    return this.backoff;
  }
}
