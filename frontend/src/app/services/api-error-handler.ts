import { Service, inject } from '@angular/core';
import { Router } from '@angular/router';

import { ApiError } from '../util/api-error';
import { Auth } from './auth';
import { GuestSession } from './guest-session';
import { ErrorMessages } from './error-messages';
import { Toasts } from './toasts';

export interface ApiErrorContext {
  /** HTTP method of the failed request. */
  readonly method: string;
  /** The caller shows violations at its form fields (FIELD_ERRORS_HANDLED_LOCALLY). */
  readonly fieldErrorsHandledLocally: boolean;
}

/**
 * What the app does when a call to our API fails:
 *  - 401: sign in again and come back (no toast - the session simply ended); a guest's session
 *    ends instead (GuestSession.end), the join page explains; after it ended nobody is sent
 *    to the identity provider
 *  - violations a form shows at its fields: nothing
 *  - everything else: an error toast with the backend's request id
 *  - 403 on a read: additionally the forbidden page (not for guests: those pages need a login) (the page cannot be shown at all)
 *  - 404 on a read: additionally the not-found page
 */
@Service()
export class ApiErrorHandler {
  private readonly auth = inject(Auth);
  private readonly toasts = inject(Toasts);
  private readonly messages = inject(ErrorMessages);
  private readonly router = inject(Router);
  private readonly guestSession = inject(GuestSession);

  handle(error: ApiError, context: ApiErrorContext): void {
    if (error.status === 401) {
      if (this.auth.guest()) {
        // the guest token was refused: the session is over, there is no login for guests
        this.guestSession.end('unauthorized');
        return;
      }
      if (this.guestSession.endedReason() && !this.auth.authenticated()) {
        // a guest whose session ended (the request went out without a token): the join page
        // explains, an anonymous visitor never lands on the identity provider
        return;
      }
      // never the fragment: it may hold a link token
      void this.auth.login(this.router.url.split('#')[0]);
      return;
    }
    if (context.fieldErrorsHandledLocally && error.violations.length > 0) {
      return;
    }
    this.toasts.error(this.messages.text(error.problem), error.requestId);
    if (this.auth.guest()) {
      return; // the error pages sit behind the login; a guest only gets the toast
    }
    if (error.status === 403 && context.method === 'GET') {
      void this.router.navigate(['/forbidden'], { skipLocationChange: true });
    }
    if (error.status === 404 && context.method === 'GET') {
      // the wildcard route of the error pages; the URL stays so a reload retries it
      void this.router.navigate(['/not-found'], { skipLocationChange: true });
    }
  }
}
