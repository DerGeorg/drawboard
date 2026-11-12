import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { GuestSession } from '../services/guest-session';

/** Pages of guest mode need a guest session; without one the join page explains what to do. */
export const guestGuard: CanActivateFn = () => {
  const session = inject(GuestSession);
  return session.active() ? true : inject(Router).createUrlTree(['/s']);
};
