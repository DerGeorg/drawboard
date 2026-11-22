import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

import { toApiError } from './api-error';
import {
  DEADLINE_JITTER_MS,
  EtagPoller,
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  PollAnswer,
} from './etag-poller';

interface Item {
  version: number;
  done?: boolean;
}

function apiError(status: number, headers: Record<string, string> = {}): Error {
  return toApiError(new HttpErrorResponse({ status, headers: new HttpHeaders(headers) }));
}

describe('EtagPoller', () => {
  let calls: (string | undefined)[];
  let answers: (() => Promise<PollAnswer<Item>>)[];
  let hidden: boolean;
  let doc: Document;
  let interval: number;
  let poller: EtagPoller<Item>;

  const changed = (value: Item, etag?: string) => () =>
    Promise.resolve<PollAnswer<Item>>({ changed: true, value, etag });
  const failing = (error: Error) => () => Promise.reject(error);

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    answers = [];
    hidden = false;
    interval = POLL_INTERVAL_MS;
    doc = document.implementation.createHTMLDocument();
    Object.defineProperty(doc, 'hidden', { get: () => hidden });
    poller = new EtagPoller<Item>({
      fetch: (etag) => {
        calls.push(etag);
        return (answers.shift() ?? failing(apiError(304)))();
      },
      doc,
      intervalMs: () => interval,
      isNewer: (next, current) => next.version >= current.version,
      isFinal: (item) => item.done === true,
    });
  });
  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('polling with ETag', () => {
    it('when started then it polls at once and after each answer with the last ETag', async () => {
      answers.push(changed({ version: 1 }, 'W/"1"'));

      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls, 'first poll without a tag').toEqual([undefined]);
      expect(poller.value()?.version, 'value').toBe(1);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(calls, 'If-None-Match').toEqual([undefined, 'W/"1"']);
    });

    it('when the interval changes then the next wait uses the new one', async () => {
      answers.push(changed({ version: 1 }, 'W/"1"'));
      interval = 1_000;

      poller.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(calls.length, 'not yet').toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls.length, 'after 1 s').toBe(2);
    });

    it('when the answer is 304 then the value and the tag stay', async () => {
      answers.push(changed({ version: 4 }, 'W/"4"'), failing(apiError(304)));

      poller.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

      expect(calls, 'same tag again').toEqual([undefined, 'W/"4"', 'W/"4"']);
      expect(poller.value()?.version, 'unchanged').toBe(4);
      expect(poller.retrying(), 'no failure').toBe(false);
    });

    it('when an answer is slow then no second request overlaps it', async () => {
      let resolve: (a: PollAnswer<Item>) => void = () => undefined;
      answers.push(() => new Promise<PollAnswer<Item>>((r) => (resolve = r)));

      poller.start();
      poller.refresh();
      poller.pollSoon();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
      expect(calls.length, 'one in flight').toBe(1);
      resolve({ changed: true, value: { version: 1 } });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      expect(calls.length, 'next after the answer').toBe(2);
    });

    it('when a final value arrives then polling stops', async () => {
      answers.push(changed({ version: 1, done: true }));

      poller.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(calls.length, 'one poll').toBe(1);
      expect(poller.active, 'stopped').toBe(false);
    });

    it('when an older value arrives after a newer one then the newer one stays', () => {
      poller.accept({ version: 5 });
      poller.accept({ version: 3 });

      expect(poller.value()?.version, 'newer').toBe(5);
    });
  });

  describe('immediate poll with jitter', () => {
    it('when pollSoon is called then the poll goes out within the jitter, not at the next tick', async () => {
      answers.push(changed({ version: 1 }, 'W/"1"'));
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      poller.pollSoon();
      await vi.advanceTimersByTimeAsync(DEADLINE_JITTER_MS / 2 - 1);
      expect(calls.length, 'before the jitter').toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(calls, 'sent with the tag').toEqual([undefined, 'W/"1"']);
    });

    it('when pollSoon is called then the delay never exceeds the jitter', async () => {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);

      poller.pollSoon(200);
      await vi.advanceTimersByTimeAsync(200);

      expect(calls.length, 'within 200 ms').toBe(2);
    });

    it('when stopped or hidden then pollSoon does nothing', async () => {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      hidden = true;
      poller.pollSoon(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(calls.length, 'hidden').toBe(1);

      hidden = false;
      poller.stop();
      poller.pollSoon(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(calls.length, 'stopped').toBe(1);
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

    it('when a back-off runs then refresh, pollSoon and a visible tab never poll before its end (Fable F2)', async () => {
      answers.push(failing(apiError(429, { 'Retry-After': '10' })));
      poller.start();
      await vi.advanceTimersByTimeAsync(0);

      poller.refresh();
      poller.pollSoon(0);
      hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls.length, 'nothing before 10 s').toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.length, 'one poll at 10 s').toBe(2);

      await vi.advanceTimersByTimeAsync(0);
      poller.refresh();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.length, 'after a good answer refresh is immediate again').toBe(3);
    });

    it('when polls keep failing then the wait doubles up to the maximum and resets after a success', async () => {
      for (let i = 0; i < 6; i++) {
        answers.push(failing(apiError(0)));
      }
      answers.push(changed({ version: 1 }));
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
      expect(poller.retrying(), 'recovered').toBe(false);
    });

    it('when the resource is gone or forbidden then polling ends with the reason', async () => {
      answers.push(failing(apiError(404)));
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(poller.end(), 'gone').toBe('gone');
      expect(poller.active, 'stopped').toBe(false);
      poller.start();
      expect(poller.active, 'no restart after the end').toBe(false);
    });

    it('when the session expired then onUnauthorized is called once and polling ends', async () => {
      let unauthorized = 0;
      const own = new EtagPoller<Item>({
        fetch: () => Promise.reject(apiError(401)),
        doc,
        onUnauthorized: () => unauthorized++,
      });

      own.start();
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      expect(unauthorized, 'handled once').toBe(1);
      expect(own.end(), 'reason').toBe('unauthorized');
    });
  });

  describe('visibility', () => {
    it('when the tab is hidden then polling pauses and resumes at once when visible', async () => {
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(calls.length, 'paused').toBe(1);

      hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);

      expect(calls.length, 'resumed').toBe(2);
    });
  });
});
