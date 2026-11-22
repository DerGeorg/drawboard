import { HttpContext } from '@angular/common/http';
import { DestroyRef, Service, computed, inject, signal } from '@angular/core';
import {
  BoardRole,
  EstimationEntry,
  EstimationSession,
  EstimationSessionState,
  EstimationSessionSummary,
  GrantRole,
  NewEstimationSession,
  PlanningService,
} from '@apps/drawboard-api';
import { Observable, firstValueFrom } from 'rxjs';

import { ApiErrorHandler } from '../../../../services/api-error-handler';
import { Auth } from '../../../../services/auth';
import { ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { ApiError } from '../../../../util/api-error';
import { refKey } from './estimation-items';
import { EstimationLease, isClosed, isRunning } from './estimation-lease';

/**
 * What the caller may do with estimation sessions on this board (E8, E13):
 * `none` - VIEWER-link guests (every call is 403, nothing is asked); `view` - members with
 * VIEWER watch; `join` - COMMENTER members and guests on COMMENTER/EDITOR links take part;
 * `create` - signed-in EDITOR/OWNER (they create; who moderates a session the server says per
 * session in `me.moderator`).
 */
export type EstimationAccess = 'none' | 'view' | 'join' | 'create';

/** Don't list the sessions more often than this (30 per user, board and minute, E17). */
export const LIST_MIN_INTERVAL_MS = 5_000;

const LOCAL = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

interface Lease {
  lease: EstimationLease;
  refs: number;
}

/**
 * Estimation sessions (Magic Estimation, Rotation; architecture 3.15) of ONE open board,
 * provided by BoardPage: the active sessions of the board (listEstimationSessions - summaries
 * only), one lease (poller + clock) per session per tab, and the operations. Nothing of a
 * session ever enters the Y.Doc or awareness (E19, E20): which cards are in a session, who sits
 * where, every value - all of it lives on the server and is read from it. Every call handles
 * its errors itself (no error page from a poll); a 401 goes to the app's usual handling.
 */
@Service({ autoProvided: false })
export class BoardEstimation {
  private readonly api = inject(PlanningService);
  private readonly auth = inject(Auth);
  private readonly errors = inject(ApiErrorHandler);

  private readonly boardId = signal<string | undefined>(undefined);
  private readonly role = signal<BoardRole | undefined>(undefined);
  private readonly active = signal<readonly EstimationSessionSummary[]>([]);
  private readonly finished = signal<readonly EstimationSessionSummary[] | undefined>(undefined);
  private readonly leases = new Map<string, Lease>();
  private lastList = 0;
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  private listing = false;

  /** The board's active sessions (LOBBY to REVIEW), newest first; empty without access. */
  readonly sessions = this.active.asReadonly();
  /** DONE and CANCELLED sessions once `loadClosed` ran (members only). */
  readonly closed = this.finished.asReadonly();

  readonly access = computed<EstimationAccess>(() => {
    const guest = this.auth.guest();
    if (guest) {
      return guest.role === GrantRole.COMMENTER || guest.role === GrantRole.EDITOR
        ? 'join'
        : 'none';
    }
    switch (this.role()) {
      case BoardRole.OWNER:
      case BoardRole.EDITOR:
        return 'create';
      case BoardRole.COMMENTER:
        return 'join';
      case BoardRole.VIEWER:
        return 'view';
      default:
        return 'none';
    }
  });

  /** Guests never moderate and cannot list closed sessions (E8). */
  readonly isGuest = computed(() => this.auth.guest() !== null);

  /**
   * The "in estimation" chip: the caller takes part in a running session. Derived from the
   * server's list (`me.seated`) only, never from awareness (E19).
   */
  readonly inEstimation = computed(() =>
    this.active().some((s) => s.me.seated && isRunning(s.state)),
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  /** The board and the caller's role on it; lists the active sessions once. */
  open(boardId: string, role: BoardRole): void {
    const changed = boardId !== this.boardId();
    this.boardId.set(boardId);
    this.role.set(role);
    if (changed) {
      this.active.set([]);
      this.finished.set(undefined);
      this.loadSessions();
    }
  }

  // ---- leases --------------------------------------------------------------------------------

  /** The lease of a session, shared in this tab; call `release` when the view closes. */
  acquire(sessionId: string): EstimationLease {
    let held = this.leases.get(sessionId);
    if (!held) {
      const boardId = this.board();
      held = {
        lease: new EstimationLease({
          fetch: (etag) => this.fetchSession(boardId, sessionId, etag),
          doc: typeof document === 'undefined' ? undefined : document,
          onUnauthorized: (e) => this.unauthorized(e),
          onSession: (s) => this.track(s),
        }),
        refs: 0,
      };
      this.leases.set(sessionId, held);
    }
    held.refs++;
    held.lease.start();
    return held.lease;
  }

  release(sessionId: string): void {
    const held = this.leases.get(sessionId);
    if (held && --held.refs <= 0) {
      held.lease.stop();
      this.leases.delete(sessionId);
    }
  }

  /** Number of sessions polled right now (tests, diagnostics). */
  get leaseCount(): number {
    return this.leases.size;
  }

  // ---- operations ----------------------------------------------------------------------------

  async create(session: NewEstimationSession): Promise<EstimationSession> {
    const created = await this.call(() =>
      this.api.createEstimationSession(
        { boardId: this.board(), newEstimationSession: session },
        'body',
        false,
        { context: LOCAL },
      ),
    );
    this.track(created);
    return created;
  }

  async join(sessionId: string): Promise<void> {
    await this.call(() =>
      this.api.joinEstimationSession({ boardId: this.board(), sessionId }, 'body', false, {
        context: LOCAL,
      }),
    );
    this.leases.get(sessionId)?.lease.refresh();
  }

  async leave(sessionId: string): Promise<void> {
    await this.call(() =>
      this.api.leaveEstimationSession({ boardId: this.board(), sessionId }, 'body', false, {
        context: LOCAL,
      }),
    );
    this.leases.get(sessionId)?.lease.refresh();
  }

  async start(sessionId: string, seatIds: readonly string[]): Promise<EstimationSession> {
    // `uniqueItems` makes the generated type a Set, which JSON.stringify writes as `{}`: send
    // the (distinct) ids as the array the contract describes
    const estimationStart = { seatIds: [...new Set(seatIds)] as unknown as Set<string> };
    return this.accepted(
      await this.call(() =>
        this.api.startEstimationSession(
          { boardId: this.board(), sessionId, estimationStart },
          'body',
          false,
          { context: LOCAL },
        ),
      ),
    );
  }

  /** Ends the phase or round the moderator sees (`state`, `round`); else 409 (E14). */
  async advance(
    sessionId: string,
    state: EstimationSessionState,
    round: number,
  ): Promise<EstimationSession> {
    return this.accepted(
      await this.call(() =>
        this.api.advanceEstimationSession(
          { boardId: this.board(), sessionId, estimationAdvance: { state, round } },
          'body',
          false,
          { context: LOCAL },
        ),
      ),
    );
  }

  /** Puts a card into a column (null: out again, PLACING only), in the phase we see (E14). */
  async place(
    sessionId: string,
    itemId: string,
    value: string | null,
    state: EstimationSessionState,
  ): Promise<void> {
    await this.call(() =>
      this.api.placeEstimationItem(
        { boardId: this.board(), sessionId, itemId, estimationPlacement: { value, state } },
        'body',
        false,
        { context: LOCAL },
      ),
    );
    // no refresh: the placement shows at once, the next poll brings the rest (and a refresh
    // would only add load during a back-off)
    this.leases.get(sessionId)?.lease.placed(itemId, value);
  }

  /** The caller's Rotation entry for a card it holds, for the round it sees (E14). */
  async estimate(
    sessionId: string,
    itemId: string,
    entry: { value: string; reason?: string; round: number },
  ): Promise<EstimationEntry> {
    const mine = await this.call(() =>
      this.api.setRotationEstimate(
        { boardId: this.board(), sessionId, itemId, rotationEstimate: entry },
        'body',
        false,
        { context: LOCAL },
      ),
    );
    this.leases.get(sessionId)?.lease.entered(itemId, mine);
    return mine;
  }

  async decide(sessionId: string, itemId: string, value: string): Promise<void> {
    await this.call(() =>
      this.api.decideEstimationItem(
        { boardId: this.board(), sessionId, itemId, estimationDecision: { value } },
        'body',
        false,
        { context: LOCAL },
      ),
    );
    this.leases.get(sessionId)?.lease.refresh();
  }

  async finish(sessionId: string): Promise<EstimationSession> {
    return this.accepted(
      await this.call(() =>
        this.api.finishEstimationSession({ boardId: this.board(), sessionId }, 'body', false, {
          context: LOCAL,
        }),
      ),
    );
  }

  async cancel(sessionId: string): Promise<EstimationSession> {
    return this.accepted(
      await this.call(() =>
        this.api.cancelEstimationSession({ boardId: this.board(), sessionId }, 'body', false, {
          context: LOCAL,
        }),
      ),
    );
  }

  /**
   * The cards the board's active sessions estimate (ref key -> session title): a hint when the
   * same card is picked again (E21, no `PLANNING_ITEM_BUSY`). Reads each active session once;
   * a failure only leaves the hint out.
   */
  async busyCards(): Promise<ReadonlyMap<string, string>> {
    const busy = new Map<string, string>();
    const boardId = this.boardId();
    if (!boardId || this.access() === 'none') {
      return busy;
    }
    await Promise.all(
      this.active().map(async (summary) => {
        try {
          const session = await firstValueFrom(
            this.api.getEstimationSession({ boardId, sessionId: summary.id }, 'body', false, {
              context: LOCAL,
            }),
          );
          for (const item of session.items) {
            busy.set(refKey(item.ref), session.title);
          }
        } catch {
          // a hint, not a must
        }
      }),
    );
    return busy;
  }

  /**
   * Lists the ACTIVE sessions again (throttled to one call per 5 s; never for `none`): on board
   * open, when the menu opens, after the caller's own create. The list holds summaries only.
   */
  loadSessions(): void {
    if (this.access() === 'none' || !this.boardId() || this.listing) {
      return;
    }
    const wait = this.lastList + LIST_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      this.listTimer ??= setTimeout(() => {
        this.listTimer = undefined;
        this.loadSessions();
      }, wait);
      return;
    }
    this.lastList = Date.now();
    this.listing = true;
    const boardId = this.board();
    this.api
      .listEstimationSessions({ boardId, state: 'ACTIVE' }, 'body', false, { context: LOCAL })
      .subscribe({
        next: (list) => {
          this.listing = false;
          if (boardId === this.boardId()) {
            this.active.set(list.items.filter((s) => !isClosed(s.state)));
          }
        },
        error: (error: unknown) => {
          this.listing = false;
          if (error instanceof ApiError && error.status === 401) {
            this.unauthorized(error);
          } else if (error instanceof ApiError && error.status === 429) {
            const seconds = Number(error.response.headers?.get('Retry-After'));
            const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
            this.lastList = Date.now() + wait - LIST_MIN_INTERVAL_MS;
            this.loadSessions();
          }
          // otherwise: no list until the next try - the list is a hint
        },
      });
  }

  /** DONE and CANCELLED sessions (members only: guests get 403 for CLOSED, E8). */
  loadClosed(): void {
    const boardId = this.boardId();
    if (!boardId || this.auth.guest() || this.access() === 'none') {
      return;
    }
    this.api
      .listEstimationSessions({ boardId, state: 'CLOSED' }, 'body', false, { context: LOCAL })
      .subscribe({
        next: (list) => {
          if (boardId === this.boardId()) {
            this.finished.set(list.items);
          }
        },
        error: (error: unknown) => {
          if (error instanceof ApiError && error.status === 401) {
            this.unauthorized(error);
          }
          this.finished.set(this.finished() ?? []);
        },
      });
  }

  // ---- internals -----------------------------------------------------------------------------

  private accepted(session: EstimationSession): EstimationSession {
    this.track(session);
    this.leases.get(session.id)?.lease.accept(session);
    return session;
  }

  /** A session we learnt something about: the board's list follows it. */
  private track(session: EstimationSession): void {
    const summary: EstimationSessionSummary = {
      id: session.id,
      mode: session.mode,
      title: session.title,
      state: session.state,
      round: session.round,
      moderatorName: session.moderatorName,
      createdAt: session.createdAt,
      seatCount: session.seats.length,
      itemCount: session.items.length,
      me: session.me,
    };
    const others = this.active().filter((s) => s.id !== session.id);
    if (isClosed(session.state)) {
      if (others.length !== this.active().length) {
        this.active.set(others);
      }
      const done = this.finished();
      if (done) {
        this.finished.set([summary, ...done.filter((s) => s.id !== session.id)]);
      }
      return;
    }
    const before = this.active().find((s) => s.id === session.id);
    if (
      !before ||
      before.state !== summary.state ||
      before.round !== summary.round ||
      before.seatCount !== summary.seatCount ||
      before.me.seated !== summary.me.seated ||
      before.me.seatId !== summary.me.seatId
    ) {
      this.active.set(
        before
          ? this.active().map((s) => (s.id === session.id ? summary : s))
          : [summary, ...others],
      );
    }
  }

  private async fetchSession(boardId: string, sessionId: string, etag: string | undefined) {
    const response = await firstValueFrom(
      this.api.getEstimationSession({ boardId, sessionId, ifNoneMatch: etag }, 'response', false, {
        context: LOCAL,
      }),
    ).catch((error: unknown) => {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        this.forget(sessionId);
      }
      throw error;
    });
    return {
      changed: true as const,
      value: response.body as EstimationSession,
      etag: response.headers.get('ETag') ?? undefined,
    };
  }

  /** A session we may not see (any more): out of the list. */
  private forget(sessionId: string): void {
    if (this.active().some((s) => s.id === sessionId)) {
      this.active.set(this.active().filter((s) => s.id !== sessionId));
    }
  }

  private async call<T>(request: () => Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(request());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.unauthorized(error);
      }
      throw error;
    }
  }

  private unauthorized(error: ApiError): void {
    this.errors.handle(error, { method: 'GET', fieldErrorsHandledLocally: false });
  }

  private board(): string {
    const id = this.boardId();
    if (!id) {
      throw new Error('BoardEstimation.open was not called');
    }
    return id;
  }

  private destroy(): void {
    clearTimeout(this.listTimer);
    for (const held of this.leases.values()) {
      held.lease.stop();
    }
    this.leases.clear();
  }
}
