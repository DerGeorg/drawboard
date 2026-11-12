import { HttpContext } from '@angular/common/http';
import { DestroyRef, Service, computed, inject, signal } from '@angular/core';
import {
  BoardRole,
  GrantRole,
  NewPokerRound,
  PlanningService,
  PokerRound,
  PokerRoundState,
} from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';
import * as Y from 'yjs';

import type { EstimateSource } from '../../../../../board-engine/blocks/story';
import { STORY_TYPE } from '../../../../../board-engine/blocks/story-model';
import type { BoardDoc } from '../../../../../board-engine/model/board-doc';
import { ApiErrorHandler } from '../../../../services/api-error-handler';
import { Auth } from '../../../../services/auth';
import { ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { ApiError } from '../../../../util/api-error';
import { PokerPoller } from './poker-poller';

/**
 * A quick round: started without a story card (contract 2.0.0, no `storyBlockId`). It never
 * binds to a card, and its result is only shown, written nowhere.
 */
export function isQuickRound(round: PokerRound): boolean {
  return round.storyBlockId === undefined || round.storyBlockId === null;
}

/**
 * What the caller may do with planning poker on this board (contract 2.0.0, S1.8 M4):
 * `none` - VIEWER-link guests (every poker call is 403); `view` - members with VIEWER see open
 * rounds but do not vote; `vote` - COMMENTER and higher, and guests on COMMENTER/EDITOR links;
 * `start` - signed-in EDITOR/OWNER (start, and reveal/cancel where they facilitate).
 */
export type PokerAccess = 'none' | 'view' | 'vote' | 'start';

/** Don't list the open rounds more often than this (30 per user, board and minute). */
export const LIST_MIN_INTERVAL_MS = 5_000;

const LOCAL = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

interface Lease {
  poller: PokerPoller;
  refs: number;
}

/**
 * Planning poker of ONE open board (provided by BoardPage): the open rounds of the board
 * (listPokerRounds, state OPEN - the "open rounds" indicator and the "estimating" chip of story
 * cards), one poller per round per tab (shared by every dialog that shows it), and the
 * operations. Votes never touch the Y.Doc (S7.6). Every call handles its errors itself (no
 * error page from a poll); a 401 still goes to the app's usual handling.
 */
@Service({ autoProvided: false })
export class BoardPoker implements EstimateSource {
  private readonly api = inject(PlanningService);
  private readonly auth = inject(Auth);
  private readonly errors = inject(ApiErrorHandler);

  private readonly boardId = signal<string | undefined>(undefined);
  private readonly role = signal<BoardRole | undefined>(undefined);
  private readonly rounds = signal<readonly PokerRound[]>([]);
  private readonly leases = new Map<string, Lease>();
  private readonly listeners = new Set<() => void>();
  private lastList = 0;
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  private listing = false;
  private unwatch: (() => void) | undefined;
  private known = new Map<string, unknown>();

  /** The board's OPEN rounds, newest first (empty without access). */
  readonly openRounds = this.rounds.asReadonly();

  readonly access = computed<PokerAccess>(() => {
    const guest = this.auth.guest();
    if (guest) {
      return guest.role === GrantRole.COMMENTER || guest.role === GrantRole.EDITOR
        ? 'vote'
        : 'none';
    }
    switch (this.role()) {
      case BoardRole.OWNER:
      case BoardRole.EDITOR:
        return 'start';
      case BoardRole.COMMENTER:
        return 'vote';
      case BoardRole.VIEWER:
        return 'view';
      default:
        return 'none';
    }
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  /** The board and the caller's role on it; lists the open rounds once. */
  open(boardId: string, role: BoardRole): void {
    const changed = boardId !== this.boardId();
    this.boardId.set(boardId);
    this.role.set(role);
    if (changed) {
      if (this.rounds().length > 0) {
        this.setRounds([]);
      }
      this.loadOpenRounds();
    }
  }

  /**
   * Lists the open rounds again when a story card's `pokerRoundId` changes in the document -
   * that is how others announce a new round (no WebSocket message for poker). Throttled.
   */
  watch(board: BoardDoc | undefined): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.known = new Map();
    if (!board) {
      return;
    }
    const roundOf = (id: string): unknown => {
      const m = board.blocksMap.get(id);
      const props = m?.get('props');
      return m?.get('type') === STORY_TYPE && props instanceof Y.Map
        ? (props as Y.Map<unknown>).get('pokerRoundId')
        : undefined;
    };
    for (const id of board.blockIds()) {
      this.known.set(id, roundOf(id));
    }
    this.unwatch = board.observe((change) => {
      let moved = false;
      for (const id of change.blocks) {
        const now = roundOf(id);
        if (now !== this.known.get(id)) {
          moved = true;
        }
        this.known.set(id, now);
      }
      if (moved) {
        this.loadOpenRounds();
      }
    });
  }

  // ---- EstimateSource (story cards on the canvas) --------------------------------------------

  isOpen(blockId: string): boolean {
    return this.rounds().some((r) => r.storyBlockId === blockId);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The open round the SERVER pairs with this card (`round.storyBlockId`), if listed; never a quick round. */
  openRoundOf(blockId: string): PokerRound | undefined {
    return this.rounds().find((r) => r.storyBlockId === blockId);
  }

  /** May the caller reveal or cancel this round? The facilitator while editor, or the owner. */
  canFacilitate(round: PokerRound): boolean {
    if (this.auth.guest()) {
      return false;
    }
    const role = this.role();
    return (
      role === BoardRole.OWNER ||
      (role === BoardRole.EDITOR &&
        !!round.facilitatorId &&
        round.facilitatorId === this.auth.user()?.id)
    );
  }

  // ---- pollers -------------------------------------------------------------------------------

  /** The poller of a round, shared in this tab; call `release` when the dialog closes. */
  acquire(roundId: string): PokerPoller {
    let lease = this.leases.get(roundId);
    if (!lease) {
      const boardId = this.boardId() as string;
      lease = {
        poller: new PokerPoller({
          fetch: (etag) => this.fetchRound(boardId, roundId, etag),
          doc: typeof document === 'undefined' ? undefined : document,
          onUnauthorized: (e) => this.unauthorized(e),
        }),
        refs: 0,
      };
      this.leases.set(roundId, lease);
    }
    lease.refs++;
    lease.poller.start();
    return lease.poller;
  }

  release(roundId: string): void {
    const lease = this.leases.get(roundId);
    if (lease && --lease.refs <= 0) {
      lease.poller.stop();
      this.leases.delete(roundId);
    }
  }

  /** Number of rounds polled right now (tests, diagnostics). */
  get pollerCount(): number {
    return this.leases.size;
  }

  // ---- operations ----------------------------------------------------------------------------

  async create(round: NewPokerRound): Promise<PokerRound> {
    const created = await this.call(() =>
      this.api.createPokerRound({ boardId: this.board(), newPokerRound: round }, 'body', false, {
        context: LOCAL,
      }),
    );
    this.setRounds([created, ...this.rounds().filter((r) => r.id !== created.id)]);
    return created;
  }

  async get(roundId: string): Promise<PokerRound> {
    return this.call(() =>
      this.api.getPokerRound({ boardId: this.board(), roundId }, 'body', false, {
        context: LOCAL,
      }),
    );
  }

  async vote(roundId: string, value: string): Promise<void> {
    await this.call(() =>
      this.api.castPokerVote(
        { boardId: this.board(), roundId, pokerVote: { value } },
        'body',
        false,
        { context: LOCAL },
      ),
    );
    const lease = this.leases.get(roundId);
    lease?.poller.voted(value);
    lease?.poller.refresh();
  }

  async reveal(roundId: string): Promise<PokerRound> {
    return this.closed(
      await this.call(() =>
        this.api.revealPokerRound({ boardId: this.board(), roundId }, 'body', false, {
          context: LOCAL,
        }),
      ),
    );
  }

  async cancel(roundId: string): Promise<PokerRound> {
    return this.closed(
      await this.call(() =>
        this.api.cancelPokerRound({ boardId: this.board(), roundId }, 'body', false, {
          context: LOCAL,
        }),
      ),
    );
  }

  /** A round we learnt is closed (409 CLOSED, a poll): out of the open list. */
  forget(roundId: string): void {
    if (this.rounds().some((r) => r.id === roundId)) {
      this.setRounds(this.rounds().filter((r) => r.id !== roundId));
    }
  }

  /**
   * Lists the OPEN rounds again (throttled to one call per 5 s; never for `none`): when a card
   * announces a round, and when the open-rounds menu opens - the only way to learn of a quick
   * round someone else started (it has no card to announce it).
   */
  loadOpenRounds(): void {
    if (this.access() === 'none' || !this.boardId() || this.listing) {
      return;
    }
    const wait = this.lastList + LIST_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      this.listTimer ??= setTimeout(() => {
        this.listTimer = undefined;
        this.loadOpenRounds();
      }, wait);
      return;
    }
    this.lastList = Date.now();
    this.listing = true;
    const boardId = this.board();
    this.api
      .listPokerRounds({ boardId, state: PokerRoundState.OPEN }, 'body', false, {
        context: LOCAL,
      })
      .subscribe({
        next: (list) => {
          this.listing = false;
          if (boardId === this.boardId()) {
            this.setRounds(list.items.filter((r) => r.state === PokerRoundState.OPEN));
          }
        },
        error: (error: unknown) => {
          this.listing = false;
          if (error instanceof ApiError && error.status === 401) {
            this.unauthorized(error);
          } else if (error instanceof ApiError && error.status === 429) {
            const seconds = Number(error.response.headers?.get('Retry-After'));
            const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
            // the next list goes out exactly when the server allows it again
            this.lastList = Date.now() + wait - LIST_MIN_INTERVAL_MS;
            this.loadOpenRounds();
          }
          // otherwise: no indicator until the next change - a list is a hint, not a must
        },
      });
  }

  // ---- internals -----------------------------------------------------------------------------

  private closed(round: PokerRound): PokerRound {
    this.forget(round.id);
    this.leases.get(round.id)?.poller.accept(round);
    return round;
  }

  private async fetchRound(boardId: string, roundId: string, etag: string | undefined) {
    const response = await firstValueFrom(
      this.api.getPokerRound({ boardId, roundId, ifNoneMatch: etag }, 'response', false, {
        context: LOCAL,
      }),
    );
    const round = response.body as PokerRound;
    if (round.state !== PokerRoundState.OPEN) {
      this.forget(round.id);
    }
    return { changed: true as const, round, etag: response.headers.get('ETag') ?? undefined };
  }

  private async call<T>(request: () => import('rxjs').Observable<T>): Promise<T> {
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
      throw new Error('BoardPoker.open was not called');
    }
    return id;
  }

  private setRounds(rounds: readonly PokerRound[]): void {
    this.rounds.set(rounds);
    for (const l of [...this.listeners]) {
      l();
    }
  }

  private destroy(): void {
    this.unwatch?.();
    clearTimeout(this.listTimer);
    for (const lease of this.leases.values()) {
      lease.poller.stop();
    }
    this.leases.clear();
    this.listeners.clear();
  }
}
