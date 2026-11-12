import {
  HttpClient,
  HttpContext,
  HttpContextToken,
  HttpInterceptorFn,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { trace } from '@opentelemetry/api';
import { firstValueFrom, from, switchMap } from 'rxjs';

import { RecordedSpans, recordSpans } from '../test/tracing';
import { startSpan, withSpan } from '../util/tracing';
import { NavigationTracing } from './navigation-tracing';
import { traceContextInterceptor, traceParentInterceptor } from './trace-interceptors';

const OTHER = new HttpContextToken<string>(() => 'default');

describe('trace interceptors', () => {
  let spans: RecordedSpans;
  let seenSpanIds: (string | undefined)[];
  let navigationContext: ReturnType<NavigationTracing['context']>;

  // like authInterceptor: continues after a promise - OpenTelemetry's stack context is lost here
  const asyncInterceptor: HttpInterceptorFn = (req, next) =>
    from(Promise.resolve()).pipe(switchMap(() => next(req)));
  // stands for Faro's fetch instrumentation: which span is active when the request goes out?
  const probe: HttpInterceptorFn = (req, next) => {
    seenSpanIds.push(trace.getActiveSpan()?.spanContext().spanId);
    return next(req);
  };

  beforeEach(() => {
    spans = recordSpans();
    seenSpanIds = [];
    navigationContext = undefined;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([
            traceContextInterceptor,
            asyncInterceptor,
            traceParentInterceptor,
            probe,
          ]),
        ),
        provideHttpClientTesting(),
        { provide: NavigationTracing, useValue: { context: () => navigationContext } },
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    spans.stop();
  });

  async function call(context?: HttpContext): Promise<void> {
    const response = firstValueFrom(TestBed.inject(HttpClient).get('/api/boards', { context }));
    await new Promise((resolve) => setTimeout(resolve)); // the async interceptor
    TestBed.inject(HttpTestingController).expectOne('/api/boards', 'GET /api/boards').flush([]);
    await response;
  }

  describe('within a span', () => {
    it('when an async interceptor sits in between then the request still goes out in the span', async () => {
      await withSpan('BoardActions.create', () => call());

      expect(seenSpanIds, 'active span when the request went out').toEqual([
        spans.byName('BoardActions.create').spanContext().spanId,
      ]);
    });

    it('when the caller passes its own HttpContext then that object is left untouched', async () => {
      const own = new HttpContext().set(OTHER, 'kept');

      await withSpan('BoardCreate.submit', () => call(own));

      expect([...own.keys()].length, 'tokens in the caller context').toBe(1);
      expect(own.get(OTHER), 'caller value').toBe('kept');
    });
  });

  describe('without a span', () => {
    it('when a navigation is in progress then the request belongs to it', async () => {
      const navigation = startSpan('navigation');
      navigationContext = navigation!.context;

      await call();

      expect(seenSpanIds, 'active span when the request went out').toEqual([
        navigation!.span.spanContext().spanId,
      ]);
    });

    it('when nothing is traced then the request goes out without a parent', async () => {
      await call();

      expect(seenSpanIds, 'active span when the request went out').toEqual([undefined]);
    });
  });
});
