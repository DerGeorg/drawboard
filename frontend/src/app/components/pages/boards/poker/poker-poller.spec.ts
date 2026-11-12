import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { PokerRound, PokerRoundState } from '@apps/drawboard-api';

import { toApiError } from '../../../../util/api-error';
import { aPokerRound } from '../testing/poker';
import { MAX_BACKOFF_MS, POLL_INTERVAL_MS, PokerPoller, RoundAnswer } from './poker-poller';

function apiError(status: number, headers: Record<string, string> = {}): Error {
  return toApiError(new HttpErrorResponse({ status, headers: new HttpHeaders(headers) }));
}

describe('PokerPoller', () => {
  let calls: (string | undefined)[];
  let answers: (() => Promise<RoundAnswer>)[];
  let poller: PokerPoller;
  let unauthorized: number;
  let hidden: boolean;
  let doc: Document;

  const changed = (round: PokerRound, etag?: string) => () =>
    Promise.resolve<RoundAnswer>({ changed: true, round, etag });
  const failing = (error: Error) => () => Promise.reject(error);

  function create(): void {
    poller = new PokerPoller({
      fetch: (etag) => {
        calls.push(etag);
        const next = answers.shift() ?? failing(apiError(304));
        return next();
      },
      doc,
      onUnauthorized: () => unauthorized++,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    answers = [];
    unauthorized = 0;
    hidden = false;
    doc = document.implementation.createHTMLDocument();
    Object.defineProperty(doc, 'hidden', { get: () => hidden });
    create();
  });
  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  describe('polling with ETag', () => {
    it('when started then it polls at once and every 2 s after an answer, with the last ETag', async () => {
      answers.push(changed(aPokerRound({ version: 1 }), 'W/"1"'));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls, 'first poll without a tag').toEqual([undefined]);
      expect(poller.round()?.version, 'round').toBe(1);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
      expect(calls.length, 'not before 2 s').toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls, 'If-None-Match').toEqual([undefined, 'W/"1"']);
    });

    it('when the answer is 304 then the round and the tag stay', async () => {
      answers.push(changed(aPokerRound({ version: 4 }), 'W/"4"'), failing(apiError(304)));

      poller.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

      expect(calls, 'same tag again').toEqual([undefined, 'W/"4"', 'W/"4"']);
      expect(poller.round()?.version, 'unchanged').toBe(4);
      expect(poller.retrying(), 'no failure').toBe(false);
    });

    it('when an answer is slow then no second request overlaps it', async () => {
      let resolve: (a: RoundAnswer) => void = () => undefined;
      answers.push(() => new Promise<RoundAnswer>((r) => (resolve = r)));

      poller.start();
      poller.refresh();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(calls.length, 'one in flight').toBe(1);
      resolve({ changed: true, round: aPokerRound() });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(calls.length, 'next after the answer').toBe(2);
    });

    it('when the round is no longer open then polling stops', async () => {
      answers.push(changed(aPokerRound({ state: PokerRoundState.REVEALED })));

      poller.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(calls.length, 'one poll').toBe(1);
      expect(poller.active, 'stopped').toBe(false);
    });

    it('when stopped then no more requests go out', async () => {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      poller.stop();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(calls.length, 'only the first').toBe(1);
    });
  });

  describe('back-off', () => {
    it('when the server answers 429 with Retry-After then the next poll waits that long', async () => {
      answers.push(failing(apiError(429, { 'Retry-After': '7' })));

      poller.start();
      await vi.advanceTimersByTimeAsync(6_999);
      expect(calls.length, 'waiting').toBe(1);
      expect(poller.retrying(), 'shown as retrying').toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls.length, 'after Retry-After').toBe(2);
    });

    it('when polls keep failing then the wait doubles up to 30 s and resets after a success', async () => {
      for (let i = 0; i < 6; i++) {
        answers.push(failing(apiError(0)));
      }
      answers.push(changed(aPokerRound()));
      poller.start();
      const gaps: number[] = [];
      let last = 0;
      for (let t = 0; t <= 120_000 && calls.length < 8; t += 500) {
        const before = calls.length;
        await vi.advanceTimersByTimeAsync(500);
        if (calls.length > before) {
          gaps.push(t + 500 - last);
          last = t + 500;
        }
      }

      expect(gaps, 'doubling, capped, then the normal interval').toEqual([
        4_000,
        8_000,
        16_000,
        MAX_BACKOFF_MS,
        MAX_BACKOFF_MS,
        MAX_BACKOFF_MS,
        POLL_INTERVAL_MS,
      ]);
    });

    it('when the round is gone or forbidden then polling ends with the reason', async () => {
      answers.push(failing(apiError(404)));
      poller.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
      expect(poller.end(), 'gone').toBe('gone');
      expect(calls.length, 'no retry').toBe(1);

      create();
      answers.push(failing(apiError(403)));
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.end(), 'forbidden').toBe('forbidden');
      poller.start();
      expect(calls.length, 'an ended poller does not start again').toBe(2);
    });

    it('when the session expired then the app handles the 401 and polling ends', async () => {
      answers.push(failing(apiError(401)));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(unauthorized, 'handed on').toBe(1);
      expect(poller.end(), 'ended').toBe('unauthorized');
    });
  });

  describe('visibility', () => {
    it('when the tab is hidden then polling pauses and resumes at once when visible', async () => {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(calls.length, 'paused').toBe(1);

      hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.length, 'resumed at once').toBe(2);
    });
  });

  describe('own vote', () => {
    it('when we voted then our vote wins over an older myVote of the server', async () => {
      answers.push(changed(aPokerRound({ myVote: '3' }), 'W/"2"'));
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.myVote(), 'server vote').toBe('3');

      poller.voted('8');
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(poller.myVote(), 'kept from the 204 across a 304').toBe('8');
    });

    it('when a round is cancelled then there is no vote any more', () => {
      poller.voted('5');
      poller.accept(aPokerRound({ state: PokerRoundState.CANCELLED, version: 9 }));

      expect(poller.myVote(), 'none').toBeUndefined();
    });

    it('when an older state arrives after a newer one then the newer one stays', () => {
      poller.accept(aPokerRound({ version: 5, title: 'new' }));
      poller.accept(aPokerRound({ version: 4, title: 'old' }));

      expect(poller.round()?.title, 'newer kept').toBe('new');
    });
  });
});
