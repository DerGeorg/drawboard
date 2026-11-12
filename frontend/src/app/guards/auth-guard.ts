import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';

import { Auth } from '../services/auth';

/** Signed in, or off to the login page - and back to the requested URL afterwards. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  if (auth.authenticated()) {
    return true;
  }
  await auth.login(state.url);
  return false;
};
