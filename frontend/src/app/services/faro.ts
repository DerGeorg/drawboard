import {
  EnvironmentProviders,
  ErrorHandler,
  Service,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import type { Faro, TransportItem } from '@grafana/faro-web-sdk';

import { reportCspViolations } from '../util/csp-violation';
import { routeTemplate } from '../util/route-template';
import { setTracingApi } from '../util/tracing';
import { stripQuery } from '../util/url';
import { NavigationTracing } from './navigation-tracing';
import { RuntimeConfig } from './runtime-config';

type FaroConfig = NonNullable<RuntimeConfig['faro']>;

/**
 * Grafana Faro: JS errors, web vitals, route views and a `traceparent` on every same-origin /api
 * call - so one trace goes from the browser span through the backend down to SQL, and the
 * backend's X-Request-Id (= trace id) shown in error toasts finds all of it.
 *
 * This app is behind a login, so Faro runs without consent banner but in STORAGE-FREE mode:
 * nothing is written to cookies, localStorage or sessionStorage; a "session" is one page load.
 * No user data is attached (never call setUser with name or e-mail), query strings and
 * fragments are stripped before sending, console capture is warn only.
 *
 * Deep tracing: once started, Faro's OpenTelemetry API is handed to util/tracing.ts, so
 * @WithSpan methods and router navigations become spans above the fetch spans.
 */
@Service()
export class FaroSession {
  private faro: Faro | undefined;

  get active(): boolean {
    return this.faro !== undefined;
  }

  /** Loads the SDK lazily (own chunks, ~60 kB gzip) and starts it - only for sampled page loads. */
  async start(config: FaroConfig, app: { version: string; environment: string }): Promise<void> {
    // Storage-free mode has no Faro session sampling: decide per page load here, and do not
    // even load the SDK when the page load is not sampled.
    if (Math.random() >= config.samplingRate) {
      return;
    }
    const [{ initializeFaro, getWebInstrumentations, LogLevel }, { TracingInstrumentation }] =
      await Promise.all([import('@grafana/faro-web-sdk'), import('@grafana/faro-web-tracing')]);

    this.faro = initializeFaro({
      url: config.collectorUrl,
      app: {
        name: config.appName, // -> service.name
        namespace: config.namespace, // -> service.namespace
        version: app.version,
        release: app.version, // source map lookup key in Alloy ({{ .Release }})
        environment: app.environment, // -> deployment.environment.name
      },
      sessionTracking: {
        enabled: false, // nothing in session/localStorage
        session: {
          id: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
          attributes: { isSampled: 'true' }, // read by the tracing sampler
        },
      },
      instrumentations: [
        ...getWebInstrumentations({
          captureConsole: true,
          // the performance instrumentation writes a navigation id to sessionStorage
          enablePerformanceInstrumentation: false,
          // window "error"/"unhandledrejection" reach Angular's ErrorHandler already
          // (provideBrowserGlobalErrorListeners) -> reported once, by FaroErrorHandler
        }).filter((i) => i.name !== '@grafana/faro-web-sdk:instrumentation-errors'),
        new TracingInstrumentation({
          // unsampled page loads send no traceparent, so the backend samples on its own
          omitTraceContextForUnsampledSessions: true,
          // same-origin /api gets traceparent automatically; list other API origins here
          instrumentationOptions: { propagateTraceHeaderCorsUrls: [] },
        }),
      ],
      consoleInstrumentation: {
        disabledLevels: [
          LogLevel.TRACE,
          LogLevel.DEBUG,
          LogLevel.LOG,
          LogLevel.INFO,
          LogLevel.ERROR,
        ],
      },
      ignoreUrls: [/\/config\.json$/],
      beforeSend: scrubTransportItem,
    });
    setTracingApi(this.faro.api.getOTEL());
    // S3.12: what the CSP and Trusted Types refuse, as events (directive, disposition, origin)
    reportCspViolations(document, (name, attributes) => this.pushEvent(name, attributes));
  }

  /** A named event with string attributes (no user data, no URLs with query strings). */
  pushEvent(name: string, attributes: Record<string, string>): void {
    this.faro?.api.pushEvent(name, attributes);
  }

  setView(name: string): void {
    this.faro?.api.setView({ name });
  }

  pushError(error: Error): void {
    this.faro?.api.pushError(error, { context: { source: 'angular' } });
  }
}

/** Angular's ErrorHandler: every uncaught error goes to Faro once, then to the console. */
@Service({ autoProvided: false })
export class FaroErrorHandler implements ErrorHandler {
  private readonly faro = inject(FaroSession);

  handleError(error: unknown): void {
    // failed HTTP calls are already visible as spans/events and toasted by ApiErrorHandler
    if (!(error instanceof HttpErrorResponse) && !isApiError(error)) {
      this.faro.pushError(
        error instanceof Error ? error : new Error(`Non-error thrown: ${String(error)}`),
      );
    }
    console.error(error); // Angular's default behaviour (level ERROR is not captured by Faro)
  }
}

function isApiError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ApiError';
}

/** Faro when the runtime config has a collector; the error handler in any case. */
export function provideFaro(config: RuntimeConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: ErrorHandler, useClass: FaroErrorHandler },
    provideAppInitializer(() => {
      const faroConfig = config.faro;
      if (!faroConfig) {
        return;
      }
      const session = inject(FaroSession);
      const navigations = inject(NavigationTracing);
      const router = inject(Router);
      router.events.subscribe((event) => {
        if (event instanceof NavigationEnd) {
          session.setView(routeTemplate(router.routerState.snapshot.root));
        }
      });
      // never let telemetry break the app: a failed chunk load only costs the telemetry
      return session
        .start(faroConfig, { version: config.version, environment: config.environment })
        .then(() => {
          if (session.active) {
            navigations.start(); // before the initial navigation: initializers run first
          }
        })
        .catch((error: unknown) => console.warn('Faro could not be started', error));
    }),
  ]);
}

/** Attribute/field names that hold a URL or a path. */
const URL_KEY = /(^|[._-])(url|uri|href|referrer|referer|target|path|location|origin)([._-]|$)/i;
/** Fields that hold nothing but the query string or the fragment: dropped entirely. */
const QUERY_KEY = /(^|[._-])(query|fragment|search|hash)$/i;
/** An absolute http(s) URL inside free text (error messages, stack frames, log lines). */
const URL_IN_TEXT = /(https?:\/\/[^\s?#"'<>)]*)[?#][^\s"'<>)]*/g;

/** A root-relative path with a query or fragment inside free text. */
const PATH_IN_TEXT = /(^|[\s"'(])(\/[\w./~%-]*)[?#][^\s"'<>)]*/g;

/**
 * Telemetry never carries a query string or a fragment: later they hold share-link tokens and
 * the contents of data URLs. Every URL leaves as origin + pathname. This walks the WHOLE item
 * (page meta, event/log/exception payloads, OTLP spans in any nesting) instead of a fixed list
 * of attribute names:
 *  - the value of every URL-like key (url.full, http.url, page.url, document.referrer ...)
 *    is cut at the first ? or #
 *  - fields that are only a query string or fragment (url.query, url.fragment) are emptied
 *  - absolute URLs inside any other string (messages, stacks, log lines) are cut as well
 * OTLP attributes are `{ key, value: { stringValue } }` pairs - the key decides there.
 */
export function scrubTransportItem(item: TransportItem): TransportItem {
  // the results count, not the inputs: frozen parts are copied, arrays are always new
  return {
    ...item,
    meta: scrubValue(item.meta, undefined) as TransportItem['meta'],
    payload: scrubValue(item.payload, undefined) as TransportItem['payload'],
  } as TransportItem;
}

function scrubText(text: string): string {
  return text.replace(URL_IN_TEXT, '$1').replace(PATH_IN_TEXT, '$1$2');
}

function scrubValue(node: unknown, key: string | undefined): unknown {
  if (typeof node === 'string') {
    if (key !== undefined && QUERY_KEY.test(key)) {
      return '';
    }
    return key !== undefined && URL_KEY.test(key) ? stripQuery(node) : scrubText(node);
  }
  if (Array.isArray(node)) {
    // a new array, never in place: some come frozen (Chrome freezes navigator.userAgentData.brands,
    // which Faro puts into every item's meta) - writing into one threw and dropped the whole item
    return node.map((child) => scrubValue(child, key));
  }
  if (node !== null && typeof node === 'object') {
    const record = writable(node as Record<string, unknown>);
    // OTLP attribute: the key is a sibling of the value
    const otlpKey = typeof record['key'] === 'string' ? record['key'] : undefined;
    for (const name of Object.keys(record)) {
      const child = record[name];
      if (name === 'value' && otlpKey && child !== null && typeof child === 'object') {
        // { key, value: { stringValue } }: the key decides how the string is treated
        const wrapper = writable(child as Record<string, unknown>);
        for (const field of Object.keys(wrapper)) {
          wrapper[field] = scrubValue(wrapper[field], otlpKey);
        }
        record[name] = wrapper;
      } else {
        record[name] = scrubValue(child, name);
      }
    }
    return record;
  }
  return node;
}

/** The object itself, or a shallow copy when it is frozen or sealed (browser-provided data). */
function writable(record: Record<string, unknown>): Record<string, unknown> {
  return Object.isFrozen(record) || Object.isSealed(record) ? { ...record } : record;
}
