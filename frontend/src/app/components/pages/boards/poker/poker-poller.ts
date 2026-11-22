import { Signal, computed, signal } from '@angular/core';
import { PokerRound, PokerRoundState } from '@apps/drawboard-api';

import { ApiError } from '../../../../util/api-error';
import {
  EtagPoller,
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  PollAnswer,
  PollEnd,
} from '../../../../util/etag-poller';

export { MAX_BACKOFF_MS, POLL_INTERVAL_MS };
export type { PollEnd };

/** One answer of getPokerRound: a new state with its ETag, or "unchanged" (304). */
export type RoundAnswer = { changed: true; round: PokerRound; etag?: string } | { changed: false };

/** Fetches the round, sending `etag` as If-None-Match; rejects with an ApiError otherwise. */
export type FetchRound = (etag: string | undefined) => Promise<RoundAnswer>;

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
 * Polls ONE planning poker round (contract `getPokerRound`) with an `EtagPoller`: every 2 s
 * after the previous answer, stopped when the round is no longer OPEN or when `stop()` is
 * called. Keeps the caller's own vote from the 204 of castPokerVote (`voted`): a changed vote
 * does not raise the round's version, so the next answers are 304s and would leave an old
 * `myVote`.
 */
export class PokerPoller {
  private readonly ownVote = signal<string | undefined>(undefined);
  private readonly poller: EtagPoller<PokerRound>;

  readonly round: Signal<PokerRound | undefined>;
  readonly end: Signal<PollEnd | undefined>;
  /** True while the last poll failed (network, server, rate limit) and a retry is waiting. */
  readonly retrying: Signal<boolean>;
  /** The caller's vote: the one we cast in this tab, else the server's `myVote`. */
  readonly myVote: Signal<string | undefined>;

  constructor(options: PollerOptions) {
    this.poller = new EtagPoller<PokerRound>({
      fetch: async (etag) => toPollAnswer(await options.fetch(etag)),
      doc: options.doc,
      onUnauthorized: options.onUnauthorized,
      intervalMs: options.intervalMs,
      maxBackoffMs: options.maxBackoffMs,
      isNewer: (next, current) => next.version >= current.version,
      isFinal: (round) => round.state !== PokerRoundState.OPEN,
    });
    this.round = this.poller.value;
    this.end = this.poller.end;
    this.retrying = this.poller.retrying;
    this.myVote = computed(() =>
      this.round()?.state === PokerRoundState.CANCELLED
        ? undefined
        : (this.ownVote() ?? this.round()?.myVote),
    );
  }

  get active(): boolean {
    return this.poller.active;
  }

  /** Starts polling at once (no-op while running or after the round ended). */
  start(): void {
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
  }

  /** Poll now instead of at the next tick (after an own vote, reveal or cancel). */
  refresh(): void {
    this.poller.refresh();
  }

  /** The 204 of castPokerVote: this is our vote now. */
  voted(value: string): void {
    this.ownVote.set(value);
  }

  /** An answer we got outside the poll (create, reveal, cancel): take it as the state. */
  accept(round: PokerRound): void {
    this.poller.accept(round);
  }
}

function toPollAnswer(answer: RoundAnswer): PollAnswer<PokerRound> {
  return answer.changed
    ? { changed: true, value: answer.round, etag: answer.etag }
    : { changed: false };
}
