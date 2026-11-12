import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { Auth } from '../services/auth';

/**
 * Instance administration (`CurrentUser.admin`, S6.6): everyone else sees the forbidden page.
 * Only the UI follows this; the backend decides by the groups claim of every request.
 */
export const adminGuard: CanActivateFn = () => {
  const auth = inject(Auth);
  return auth.user()?.admin === true || inject(Router).parseUrl('/forbidden');
};
