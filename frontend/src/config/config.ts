import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { TitleStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { provideApi } from '@apps/drawboard-api';

import { Auth } from '../app/services/auth';
import { authInterceptor } from '../app/services/auth-interceptor';
import { errorInterceptor } from '../app/services/error-interceptor';
import { provideFaro } from '../app/services/faro';
import { OIDC_CLIENT, createUserManager } from '../app/services/oidc-client';
import { OidcAuth } from '../app/services/oidc-auth';
import { PageTitle } from '../app/services/page-title';
import { RUNTIME_CONFIG, RuntimeConfig } from '../app/services/runtime-config';
import {
  traceContextInterceptor,
  traceParentInterceptor,
} from '../app/services/trace-interceptors';
import { routes } from './router';

/**
 * Application providers. A function, not a constant: main.ts loads the runtime config before
 * bootstrap, because the OIDC client and Faro need their URLs synchronously when they are created.
 *
 * Interceptor order: trace context first (captured while the calling @WithSpan method still
 * runs), then the token, then error handling - the error interceptor sees the final request and
 * the backend's answer including its X-Request-Id - and trace parent last (the fetch runs in the
 * captured context, so its span is a child of the Angular span).
 */
export function appConfig(runtime: RuntimeConfig): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      provideRouter(routes, withComponentInputBinding()),
      { provide: TitleStrategy, useClass: PageTitle },
      provideHttpClient(
        withInterceptors([
          traceContextInterceptor,
          authInterceptor,
          errorInterceptor,
          traceParentInterceptor,
        ]),
      ),
      // generated client of the contract: relative base path -> same origin, no backend URL here
      provideApi(runtime.apiBaseUrl),
      { provide: RUNTIME_CONFIG, useValue: runtime },
      { provide: OIDC_CLIENT, useValue: createUserManager(runtime) },
      OidcAuth,
      { provide: Auth, useExisting: OidcAuth },
      // before the first navigation: finish a login redirect or try the silent sign-in
      provideAppInitializer(() => inject(OidcAuth).start()),
      provideFaro(runtime),
    ],
  };
}
