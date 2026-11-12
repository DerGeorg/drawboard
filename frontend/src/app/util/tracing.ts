import type {
  Attributes,
  Context,
  ContextAPI,
  Span,
  SpanStatusCode,
  TimeInput,
  TraceAPI,
} from '@opentelemetry/api';
import { Observable, isObservable } from 'rxjs';

/**
 * Spans for our own code - the browser counterpart of the backend's @WithSpan.
 *
 * The OpenTelemetry API comes from Faro (`faro.api.getOTEL()`, registered by FaroSession once the
 * lazily loaded tracing chunk is up). Until then, when Faro is off or the page load is not
 * sampled, every function here is a no-op that just runs the code: no SDK in the main bundle,
 * no spans, no cost.
 *
 * Context propagation without zone.js: OpenTelemetry's StackContextManager only knows the
 * context during SYNCHRONOUS execution. withSpan() runs the traced code inside `context.with`,
 * so everything the method starts before its first `await` - nested @WithSpan calls, the
 * HttpClient call (subscribed synchronously by firstValueFrom) - is a child. The HTTP call
 * survives async interceptors because traceContextInterceptor remembers the context and
 * traceParentInterceptor runs the fetch inside it (services/trace-interceptors.ts). Work that
 * starts after an `await` is NOT a child - start the traced call before the first `await`.
 */
export interface OtelApi {
  readonly trace: TraceAPI;
  readonly context: ContextAPI;
}

/** Instrumentation scope of our own spans (otel.scope.name in Tempo). */
export const TRACER_NAME = 'app';

const STATUS_ERROR = 2 satisfies SpanStatusCode.ERROR;

let otel: OtelApi | undefined;

/** Called by FaroSession once tracing is registered; `undefined` switches tracing off (tests). */
export function setTracingApi(api: OtelApi | undefined): void {
  otel = api;
}

export interface WithSpanOptions {
  /** Low-cardinality, non-personal attributes only: ids yes, titles or e-mail addresses never. */
  readonly attributes?: Attributes;
}

/**
 * Runs `fn` inside a new span `name` (child of the active span, if any) and ends the span when
 * the work is done: on return, when a returned Promise settles, when a returned Observable
 * completes, errors or is unsubscribed. Errors mark the span (status ERROR, exception event)
 * and are re-thrown unchanged.
 */
export function withSpan<T>(name: string, fn: () => T, options: WithSpanOptions = {}): T {
  const api = otel;
  if (!api) {
    return fn();
  }
  const span = api.trace.getTracer(TRACER_NAME).startSpan(name, {
    attributes: options.attributes,
  });
  const spanContext = api.trace.setSpan(api.context.active(), span);
  let result: T;
  try {
    result = api.context.with(spanContext, fn);
  } catch (error) {
    fail(span, error);
    span.end();
    throw error;
  }
  if (result instanceof Promise) {
    return result.then(
      (value: unknown) => {
        span.end();
        return value;
      },
      (error: unknown) => {
        fail(span, error);
        span.end();
        throw error;
      },
    ) as T;
  }
  if (isObservable(result)) {
    return traceObservable(api, spanContext, span, result) as T;
  }
  span.end();
  return result;
}

/** What @WithSpan returns: a legacy (experimentalDecorators) and a standard method decorator. */
export interface WithSpanDecorator<A extends unknown[]> {
  <M extends TracedMethod<A>>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<M>,
  ): TypedPropertyDescriptor<M>;
  <M extends TracedMethod<A>>(method: M, context: ClassMethodDecoratorContext): M;
}

/** A method whose leading parameters are what the `attributes` callback takes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any other parameters may follow
type TracedMethod<A extends unknown[]> = (...args: [...A, ...any[]]) => unknown;

/**
 * Method decorator: `@WithSpan('BoardActions.complete')` wraps the method in withSpan().
 *
 * The name is REQUIRED and must be `<Class>.<method>` (checked by @ci/with-span-on-actions):
 * the production build minifies class names, so `this.constructor.name` would be "e".
 * `attributes` receives the method's arguments.
 *
 * Works with TypeScript's legacy decorators (`experimentalDecorators`, what Angular CLI 22
 * generates) and with standard decorators.
 */
export function WithSpan<A extends unknown[] = never[]>(
  name: string,
  options: { readonly attributes?: (...args: A) => Attributes } = {},
): WithSpanDecorator<A> {
  const traced = <M extends TracedMethod<A>>(method: M): M =>
    function (this: unknown, ...args: Parameters<M>): unknown {
      return withSpan(name, () => method.apply(this, args), {
        attributes: attributesOf(options.attributes, args as unknown[] as A),
      });
    } as M;

  return (<M extends TracedMethod<A>>(
    target: object | M,
    keyOrContext: string | symbol | ClassMethodDecoratorContext,
    descriptor?: TypedPropertyDescriptor<M>,
  ): TypedPropertyDescriptor<M> | M => {
    if (typeof keyOrContext === 'object') {
      return traced(target as M); // standard decorator: (method, context) -> replacement
    }
    if (typeof descriptor?.value !== 'function') {
      throw new TypeError(`@WithSpan('${name}') can only decorate methods`);
    }
    return { ...descriptor, value: traced(descriptor.value) }; // legacy: -> descriptor
  }) as WithSpanDecorator<A>;
}

/** Telemetry must never break the app: a failing attributes callback only costs the attributes. */
function attributesOf<A extends unknown[]>(
  attributes: ((...args: A) => Attributes) | undefined,
  args: A,
): Attributes | undefined {
  try {
    return attributes?.(...args);
  } catch {
    return undefined;
  }
}

/** The active context when it carries a span (a @WithSpan method is running), else undefined. */
export function activeTraceContext(): Context | undefined {
  const api = otel;
  if (!api) {
    return undefined;
  }
  const active = api.context.active();
  return api.trace.getSpan(active) ? active : undefined;
}

/**
 * Creates and subscribes the Observable of `source` inside `parent`: whatever runs meanwhile -
 * following interceptors, the fetch of an HttpClient call - sees `parent` as active context.
 */
export function inTraceContext<T>(parent: Context, source: () => Observable<T>): Observable<T> {
  const api = otel;
  if (!api) {
    return source();
  }
  return new Observable<T>((subscriber) =>
    api.context.with(parent, () => source().subscribe(subscriber)),
  );
}

/** A span with its context - for spans that live longer than one call (navigations). */
export interface OpenSpan {
  readonly span: Span;
  readonly context: Context;
}

/** Starts a span that the caller ends; `parent` defaults to the active context. */
export function startSpan(
  name: string,
  options: { attributes?: Attributes; startTime?: TimeInput; parent?: Context } = {},
): OpenSpan | undefined {
  const api = otel;
  if (!api) {
    return undefined;
  }
  const parent = options.parent ?? api.context.active();
  const span = api.trace
    .getTracer(TRACER_NAME)
    .startSpan(name, { attributes: options.attributes, startTime: options.startTime }, parent);
  return { span, context: api.trace.setSpan(parent, span) };
}

/** Status ERROR, `error.type` and an exception event - what the backend's @WithSpan records. */
export function fail(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setAttribute('error.type', exception.name);
  span.setStatus({ code: STATUS_ERROR, message: exception.message });
}

function traceObservable<T>(
  api: OtelApi,
  spanContext: Context,
  span: Span,
  source: Observable<T>,
): Observable<T> {
  let ended = false;
  const end = (): void => {
    if (!ended) {
      ended = true;
      span.end();
    }
  };
  return new Observable<T>((subscriber) => {
    const subscription = api.context.with(spanContext, () =>
      source.subscribe({
        next: (value) => subscriber.next(value),
        error: (error: unknown) => {
          fail(span, error);
          end();
          subscriber.error(error);
        },
        complete: () => {
          end();
          subscriber.complete();
        },
      }),
    );
    return () => {
      subscription.unsubscribe();
      end(); // unsubscribed before completion (switchMap, component destroyed): still ended
    };
  });
}
