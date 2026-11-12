import { HttpContextToken, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

import { toApiError } from '../util/api-error';
import { isOwnApiRequest } from '../util/own-api-request';
import { ApiErrorHandler } from './api-error-handler';
import { RUNTIME_CONFIG } from './runtime-config';

/**
 * Set by forms that show VALIDATION_FAILED violations at their fields - then no toast for them.
 * Through the generated client: `createBoard(params, 'body', false, { context })`.
 */
export const FIELD_ERRORS_HANDLED_LOCALLY = new HttpContextToken<boolean>(() => false);

/**
 * Set by callers that show every failure themselves (opening a share link: wrong password, link
 * expired, rate limited ...): the ApiError is still thrown, but no toast, no login redirect and
 * no not-found page. Through the generated client: `exchangeShareToken(params, 'body', false, { context })`.
 */
export const ERRORS_HANDLED_LOCALLY = new HttpContextToken<boolean>(() => false);

/**
 * Every failed call to our API becomes an ApiError (with the backend's request id); the side
 * effects (toast, login, forbidden page) live in ApiErrorHandler. The ApiError is re-thrown so
 * resources and forms can react as well.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const apiBaseUrl = inject(RUNTIME_CONFIG).apiBaseUrl;
  if (!isOwnApiRequest(req.url, apiBaseUrl)) {
    return next(req);
  }
  const handler = inject(ApiErrorHandler);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }
      const apiError = toApiError(error);
      if (req.context.get(ERRORS_HANDLED_LOCALLY)) {
        return throwError(() => apiError);
      }
      handler.handle(apiError, {
        method: req.method,
        fieldErrorsHandledLocally: req.context.get(FIELD_ERRORS_HANDLED_LOCALLY),
      });
      return throwError(() => apiError);
    }),
  );
};
