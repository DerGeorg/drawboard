import {
  HttpContext,
  HttpContextToken,
  HttpInterceptorFn,
  HttpRequest,
} from '@angular/common/http';
import { inject } from '@angular/core';
import type { Context } from '@opentelemetry/api';

import { activeTraceContext, inTraceContext } from '../util/tracing';
import { NavigationTracing } from './navigation-tracing';

/** The trace context an HTTP call was made in - carried from the first to the last interceptor. */
const TRACE_PARENT = new HttpContextToken<Context | undefined>(() => undefined);

/**
 * FIRST interceptor. HttpClient runs the interceptor chain synchronously when the call is
 * subscribed - still inside the @WithSpan method that made it - so the active context here is
 * the method's span. Without one (a resource loading after a route change) the call belongs to
 * the navigation in progress, if any. The context travels with the request to
 * traceParentInterceptor.
 */
export const traceContextInterceptor: HttpInterceptorFn = (req, next) => {
  const parent = activeTraceContext() ?? inject(NavigationTracing).context();
  return next(parent ? withTraceParent(req, parent) : req);
};

/**
 * LAST interceptor. Interceptors in between may continue asynchronously (authInterceptor waits
 * for the token), which loses OpenTelemetry's stack-based context. Subscribing the backend
 * inside the remembered context makes Faro's fetch span - and with it the traceparent header,
 * the backend trace and the X-Request-Id - a child of the Angular span.
 */
export const traceParentInterceptor: HttpInterceptorFn = (req, next) => {
  const parent = req.context.get(TRACE_PARENT);
  return parent ? inTraceContext(parent, () => next(req)) : next(req);
};

/** A copy of the request context: the caller's HttpContext may be reused for other calls. */
function withTraceParent(req: HttpRequest<unknown>, parent: Context): HttpRequest<unknown> {
  const context = new HttpContext();
  for (const token of req.context.keys()) {
    context.set(token, req.context.get(token));
  }
  return req.clone({ context: context.set(TRACE_PARENT, parent) });
}
