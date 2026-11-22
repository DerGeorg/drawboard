import { signal } from '@angular/core';

import { ApiError } from './api-error';

/** Default wait between two polls. */
export const POLL_INTERVAL_MS = 2_000;
/** Longest wait between two polls after failures (network, 5xx, 429 without Retry-After). */
export const MAX_BACKOFF_MS = 30_000;
/** Longest wait a Retry-After header may ask for. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Spread of an immediate poll (`pollSoon`), so that a deadline does not hit the server at once. */
export const DEADLINE_JITTER_MS = 500;

/** One answer of a conditional GET: a new value with its ETag, or "unchanged" (304). */
export type PollAnswer<T> = { changed: true; value: T; etag?: string } | { changed: false };

/** Fetches the resource, sending `etag` as If-None-Match; rejects with an ApiError otherwise. */
export type PollFetch<T> = (etag: string | undefined) => Promise<PollAnswer<T>>;

/** Why polling stopped for good: the resource does not exist for us, or we may not see it. */
export type PollEnd = 'gone' | 'forbidden' | 'unauthorized';

export interface EtagPollerOptions<T> {
  fetch: PollFetch<T>;
  /** Visibility source (the page's document); polling pauses while it is hidden. */
  doc?: Document;
  /** A 401: the app's usual handling (login, end of a guest session). */
  onUnauthorized?(error: ApiError): void;
  /** Wait after an answer; a function is read before every wait (a phase may poll faster). */
  intervalMs?: number | (() => number);
  maxBackoffMs?: number;
  /** Whether `next` may replace `current` (default: always). */
  isNewer?(next: T, current: T): boolean;
  /** Whether `value` is final: polling stops after taking it (default: never). */
  isFinal?(value: T): boolean;
}

/**
 * Polls ONE resource with a conditional GET: every interval after the previous answer (never
 * overlapping), with the last ETag in If-None-Match (304 = unchanged), backing off on 429
 * (Retry-After) and on failures, paused while the tab is hidden, stopped on a final value, on
 * 401/403/404 or when `stop()` is called.
 */
export class EtagPoller<T> {
  private readonly current = signal<T | undefined>(undefined);
  private readonly ended = signal<PollEnd | undefined>(undefined);
  private readonly failing = signal(false);

  readonly value = this.current.asReadonly();
  readonly end = this.ended.asReadonly();
  /** True while the last poll failed (network, server, rate limit) and a retry is waiting. */
  readonly retrying = this.failing.asReadonly();

  private etag: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight = false;
  private backoff = 0;
  /**
   * After a failure (429 with Retry-After, back-off): no poll before this time (epoch ms), also
   * not through `refresh()`, `pollSoon()` or a tab that becomes visible again.
   */
  private notBefore = 0;
  private readonly maxBackoff: number;
  private readonly onVisibility = (): void => {
    if (this.options.doc?.hidden) {
      clearTimeout(this.timer);
      this.timer = undefined;
    } else if (this.running && !this.inFlight && this.timer === undefined) {
      this.pollAfter(0);
    }
  };

  constructor(private readonly options: EtagPollerOptions<T>) {
    this.maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_MS;
  }

  get active(): boolean {
    return this.running;
  }

  private get interval(): number {
    const interval = this.options.intervalMs ?? POLL_INTERVAL_MS;
    return typeof interval === 'function' ? interval() : interval;
  }

  /** Starts polling at once (no-op while running or after the end). */
  start(): void {
    if (this.running || this.ended()) {
      return;
    }
    this.running = true;
    this.options.doc?.addEventListener('visibilitychange', this.onVisibility);
    this.pollAfter(0);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.options.doc?.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Poll now instead of at the next tick (after an own action); never during a back-off. */
  refresh(): void {
    if (!this.running || this.inFlight) {
      return;
    }
    this.pollAfter(0);
  }

  /**
   * Poll within `jitterMs` (a random 0 to jitterMs) instead of at the next tick: for a deadline
   * that every client sees at the same moment. No-op while stopped, hidden or a poll is running.
   */
  pollSoon(jitterMs = DEADLINE_JITTER_MS): void {
    if (!this.running || this.inFlight || this.options.doc?.hidden) {
      return;
    }
    this.pollAfter(Math.floor(Math.random() * (jitterMs + 1)));
  }

  /** An answer we got outside the poll (create, reveal, cancel): take it as the state. */
  accept(value: T): void {
    const before = this.current();
    if (before === undefined || !this.options.isNewer || this.options.isNewer(value, before)) {
      this.current.set(value);
    }
    if (this.options.isFinal?.(value)) {
      this.stop();
    }
  }

  /**
   * Schedules the next poll in `delay` ms - or, during a back-off, at its end (whichever is
   * later): a wait the server asked for is never cut short.
   */
  private pollAfter(delay: number): void {
    clearTimeout(this.timer);
    const wait = Math.max(delay, this.notBefore - Date.now());
    if (wait <= 0) {
      this.timer = undefined;
      void this.poll();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, wait);
  }

  private async poll(): Promise<void> {
    if (!this.running || this.options.doc?.hidden) {
      return;
    }
    this.inFlight = true;
    let delay: number | undefined;
    try {
      const answer = await this.options.fetch(this.etag);
      if (answer.changed) {
        this.etag = answer.etag ?? this.etag;
        this.accept(answer.value);
      }
      this.backoff = 0;
      this.notBefore = 0;
      this.failing.set(false);
    } catch (error) {
      delay = this.failed(error);
      this.notBefore = this.failing() ? Date.now() + delay : 0;
    } finally {
      this.inFlight = false;
    }
    // read after the answer: the value just taken may ask for another interval
    delay ??= this.interval;
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
    const interval = this.interval;
    this.backoff = Math.min(this.maxBackoff, this.backoff === 0 ? interval * 2 : this.backoff * 2);
    if (status === 429 && error instanceof ApiError) {
      const seconds = Number(error.response.headers?.get('Retry-After'));
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      }
    }
    return this.backoff;
  }
}
