import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { EnvironmentProviders, Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideApi } from '@apps/drawboard-api';

import { authInterceptor } from '../services/auth-interceptor';
import { errorInterceptor } from '../services/error-interceptor';
import { traceContextInterceptor, traceParentInterceptor } from '../services/trace-interceptors';
import { provideTestRuntimeConfig } from './runtime-config';

/**
 * HttpClient exactly as in config.ts (same interceptors, same order) on top of Angular's
 * testing backend, plus the generated client and the runtime config. Needs an Auth provider.
 */
export function provideHttpTesting(): (Provider | EnvironmentProviders)[] {
  return [
    provideHttpClient(
      withInterceptors([
        traceContextInterceptor,
        authInterceptor,
        errorInterceptor,
        traceParentInterceptor,
      ]),
    ),
    provideHttpClientTesting(),
    provideApi('/api'),
    provideTestRuntimeConfig(),
  ];
}

/**
 * Expects exactly one request with this method and path (query string ignored). The
 * description is the failure message - the "message on every expect" rule for HTTP.
 */
export function expectRequest(method: string, path: string, description?: string): TestRequest {
  return TestBed.inject(HttpTestingController).expectOne(
    (req) => req.method === method && req.url === path,
    description ?? `${method} ${path}`,
  );
}

/**
 * Resources and the async token interceptor need a moment: the request reaches the testing
 * backend only after the resource effect ran and the token promise resolved.
 */
export async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

/** A problem+json error response as the backend sends it. */
export function problemResponse(
  status: number,
  statusText: string,
  requestId = 'req-test',
): { status: number; statusText: string; headers: Record<string, string> } {
  return { status, statusText, headers: { 'X-Request-Id': requestId } };
}
