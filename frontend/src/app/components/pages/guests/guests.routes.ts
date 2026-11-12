import { Routes } from '@angular/router';

import { guestGuard } from '../../../guards/guest-guard';
import { GuestJoin } from './guest-join/guest-join';

/**
 * Domain "guests" - child routes below /s, PUBLIC (no authGuard: the visitor may not have an
 * account). `/s` opens a link (the token is in the fragment); `/s/b/:boardId` and
 * `/s/f/:folderId` are the guest views, only reachable with a guest session (guestGuard).
 */
export default [
  { path: '', component: GuestJoin, title: 'Open a link' },
  {
    path: 'b/:boardId',
    canActivate: [guestGuard],
    loadComponent: () => import('../boards/board-page/board-page').then((m) => m.BoardPage),
    title: 'Shared board',
  },
  {
    path: 'f/:folderId',
    canActivate: [guestGuard],
    loadComponent: () => import('./guest-folder/guest-folder').then((m) => m.GuestFolder),
    title: 'Shared folder',
  },
] satisfies Routes;
