import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';

import { isOwnApiRequest } from '../util/own-api-request';
import { Auth } from './auth';
import { RUNTIME_CONFIG } from './runtime-config';

/**
 * Bearer token for relative calls below the API base path only (/api/…) - never for absolute
 * or third-party URLs. The token is refreshed shortly before it expires.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const apiBaseUrl = inject(RUNTIME_CONFIG).apiBaseUrl;
  if (!isOwnApiRequest(req.url, apiBaseUrl) || req.headers.has('Authorization')) {
    return next(req);
  }
  const auth = inject(Auth);
  return from(auth.token()).pipe(
    switchMap((token) =>
      next(token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req),
    ),
  );
};
