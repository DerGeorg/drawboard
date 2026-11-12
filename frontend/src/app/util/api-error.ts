import { HttpErrorResponse } from '@angular/common/http';
import { ErrorModel, FieldViolation } from '@apps/drawboard-api';

/** Response header with the backend's request id (= trace id for browser calls). */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * ErrorModel as the frontend must treat it: `code` is a plain string because the backend may
 * send codes this build does not know yet (a new code is not a breaking contract change).
 */
export type Problem = Omit<ErrorModel, 'code'> & { readonly code: string };

/** Codes the frontend itself produces when there is no problem+json body. */
export const CLIENT_ERROR_CODES = {
  network: 'CLIENT_NETWORK_ERROR',
  unexpectedResponse: 'CLIENT_UNEXPECTED_RESPONSE',
} as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

/** What every failed call to our API rejects with (after errorInterceptor). */
export class ApiError extends Error {
  constructor(
    readonly problem: Problem,
    /** The id to quote to support: from the body, else the X-Request-Id response header. */
    readonly requestId: string | undefined,
    readonly response: HttpErrorResponse,
  ) {
    super(`${problem.status} ${problem.code}: ${problem.detail ?? problem.title}`);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.problem.status;
  }

  get code(): string {
    return this.problem.code;
  }

  get violations(): readonly FieldViolation[] {
    return this.problem.violations ?? [];
  }
}

function isProblem(body: unknown): body is Problem {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Problem).code === 'string' &&
    typeof (body as Problem).status === 'number'
  );
}

/** problem+json may arrive parsed, or as text (e.g. when the request expected no JSON body). */
function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') {
    return body;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Turns any HttpErrorResponse into an ApiError. Never throws; tolerates HTML error pages of
 * proxies and network errors (status 0, no response - then there is no request id either).
 */
export function toApiError(error: HttpErrorResponse): ApiError {
  const requestIdHeader = error.headers?.get(REQUEST_ID_HEADER) ?? undefined;
  const body = parseBody(error.error);
  if (isProblem(body)) {
    return new ApiError(body, body.requestId ?? requestIdHeader, error);
  }
  const timestamp = new Date().toISOString();
  const problem: Problem =
    error.status === 0
      ? { code: CLIENT_ERROR_CODES.network, status: 0, title: 'Network error', timestamp }
      : {
          code: CLIENT_ERROR_CODES.unexpectedResponse,
          status: error.status,
          title: error.statusText || `HTTP ${error.status}`,
          timestamp,
        };
  return new ApiError(problem, requestIdHeader, error);
}
