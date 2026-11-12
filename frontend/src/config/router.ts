import { Routes } from '@angular/router';

import { adminGuard } from '../app/guards/admin-guard';
import { authGuard } from '../app/guards/auth-guard';

/**
 * Global router: only the top level. Every domain owns its child routes in
 * components/pages/<domain>/<domain>.routes.ts (default export, one lazy chunk per domain).
 * The whole app is behind the login (authGuard on the root) except /s, which opens share links; what a user may do with a board
 * is decided by the backend (Board.role), not by route guards.
 */
export const routes: Routes = [
  // opening a share link: public, the visitor may be anonymous (guest mode, architecture S1)
  { path: 's', loadChildren: () => import('../app/components/pages/guests/guests.routes') },
  {
    path: '',
    canActivateChild: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'boards' },
      {
        path: 'boards',
        loadChildren: () => import('../app/components/pages/boards/boards.routes'),
      },
      // a board in a data URL (needs the login): /open#v1.<data>
      { path: 'open', loadChildren: () => import('../app/components/pages/open/open.routes') },
      // instance administration (plugins): admins only
      {
        path: 'admin',
        canActivate: [adminGuard],
        loadChildren: () => import('../app/components/pages/admin/admin.routes'),
      },
      // forbidden + not found; last, because it ends with the wildcard
      { path: '', loadChildren: () => import('../app/components/pages/errors/errors.routes') },
    ],
  },
];
