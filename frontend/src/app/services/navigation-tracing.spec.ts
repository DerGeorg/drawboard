import { PendingTasks } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { RecordedSpans, parentId, recordSpans } from '../test/tracing';
import { setTracingApi } from '../util/tracing';
import { NavigationTracing, SETTLE_TIMEOUT_MS } from './navigation-tracing';

const ERROR = 2;

/** Stands in for the browser's PerformanceObserver (jsdom has none): entries are pushed by hand. */
class FakePerformanceObserver {
  static current: FakePerformanceObserver | undefined;
  static pending: Partial<PerformanceResourceTiming>[] = [];
  disconnected = false;

  constructor(readonly callback: (list: { getEntries(): PerformanceEntryList }) => void) {
    FakePerformanceObserver.current = this;
  }

  observe(): void {
    // entries arrive through emit()
  }

  takeRecords(): PerformanceEntryList {
    const records = FakePerformanceObserver.pending as PerformanceEntryList;
    FakePerformanceObserver.pending = [];
    return records;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(entries: Partial<PerformanceResourceTiming>[]): void {
    this.callback({ getEntries: () => entries as PerformanceEntryList });
  }
}

describe('NavigationTracing', () => {
  let spans: RecordedSpans;
  let router: Router;
  let tracing: NavigationTracing;

  beforeEach(() => {
    spans = recordSpans();
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'boards/:boardId', children: [] },
          { path: 'blocked', children: [], canActivate: [() => false] },
          {
            path: 'broken',
            children: [],
            canActivate: [
              () => {
                throw new Error('guard failure');
              },
            ],
          },
        ]),
      ],
    });
    router = TestBed.inject(Router);
    tracing = TestBed.inject(NavigationTracing);
    tracing.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    spans.stop();
  });

  /** Lets the navigation span see the app become stable and end. */
  async function settled(): Promise<void> {
    await TestBed.inject(Router).navigated;
    await new Promise((resolve) => setTimeout(resolve));
  }

  describe('successful navigation', () => {
    it('when a route is reached then one span named after the route template is recorded', async () => {
      await router.navigateByUrl('/boards/42');
      await settled();

      const span = spans.byName('navigation /boards/:boardId');
      expect(span.attributes, 'attributes').toEqual({
        'navigation.trigger': 'imperative',
        'url.template': '/boards/:boardId',
        'navigation.outcome': 'end',
      });
      expect(parentId(span), 'navigation is a root span').toBe('');
      expect(tracing.context(), 'context after the navigation').toBeUndefined();
    });

    it('when the navigation is open then its context is offered to HTTP calls', async () => {
      const pendingTasks = TestBed.inject(PendingTasks);
      const done = pendingTasks.add(); // data still loading
      await router.navigateByUrl('/boards/7');

      expect(tracing.context(), 'context while the page loads').toBeDefined();
      done();
      await settled();
      expect(tracing.context(), 'context once settled').toBeUndefined();
    });

    it('when chunks are downloaded during the navigation then they become resource spans', async () => {
      const done = TestBed.inject(PendingTasks).add();
      await router.navigateByUrl('/boards/1');
      FakePerformanceObserver.current!.emit([
        { initiatorType: 'script', name: '/chunk-a.js?v=1', startTime: 1, responseEnd: 2 },
        { initiatorType: 'fetch', name: '/api/boards/1', startTime: 1, responseEnd: 3 },
      ]);
      FakePerformanceObserver.pending = [
        { initiatorType: 'link', name: '/styles.css', startTime: 2, responseEnd: 4 },
      ];
      done();
      await settled();

      const navigation = spans.byName('navigation /boards/:boardId');
      const resources = spans.finished().filter((s) => s.name.startsWith('resource'));
      expect(
        resources.map((s) => [s.name, s.attributes['url.full']]),
        'resource spans (fetch has its own span)',
      ).toEqual([
        ['resource script', '/chunk-a.js'],
        ['resource link', '/styles.css'],
      ]);
      expect(
        resources.every((s) => parentId(s) === navigation.spanContext().spanId),
        'resources are children of the navigation',
      ).toBe(true);
      expect(FakePerformanceObserver.current!.disconnected, 'observer disconnected').toBe(true);
    });

    it('when the page never settles then the span ends after the timeout', async () => {
      TestBed.inject(PendingTasks).add(); // never removed
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await router.navigateByUrl('/boards/9');
      expect(spans.finished(), 'spans before the timeout').toEqual([]);

      await vi.advanceTimersByTimeAsync(SETTLE_TIMEOUT_MS);

      expect(spans.byName('navigation /boards/:boardId').ended, 'span ended by the timeout').toBe(
        true,
      );
    });
  });

  describe('unsuccessful navigation', () => {
    it('when a guard blocks the route then the span is marked cancelled', async () => {
      await router.navigateByUrl('/blocked');

      expect(
        spans.byName('navigation').attributes['navigation.outcome'],
        'outcome of a blocked navigation',
      ).toBe('cancelled');
    });

    it('when a guard throws then the span is an error', async () => {
      await expect(router.navigateByUrl('/broken'), 'navigation result').rejects.toThrow(
        'guard failure',
      );

      const span = spans.byName('navigation');
      expect(span.status.code, 'status').toBe(ERROR);
      expect(span.attributes['navigation.outcome'], 'outcome').toBe('error');
    });

    it('when the next navigation starts before the page settled then the first one is superseded', async () => {
      const done = TestBed.inject(PendingTasks).add();
      await router.navigateByUrl('/boards/1');
      await router.navigateByUrl('/boards/2');
      done();
      await settled();

      expect(
        spans.finished().map((s) => s.attributes['navigation.outcome']),
        'outcomes in the order the spans ended',
      ).toEqual(['superseded', 'end']);
    });

    it('when tracing is off then navigations record nothing', async () => {
      setTracingApi(undefined);

      await router.navigateByUrl('/boards/3');
      await settled();

      expect(spans.finished(), 'spans').toEqual([]);
      expect(tracing.context(), 'context').toBeUndefined();
    });
  });
});
