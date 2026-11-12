import { Routes } from '@angular/router';

import { BoardList } from './board-list/board-list';

/**
 * Domain "boards" - child routes below /boards (router.ts adds the authGuard). The list is
 * part of the domain chunk, the board page is lazy on its own. What the user may do with a
 * board is decided by the backend (Board.role), not by guards.
 */
export default [
  { path: '', component: BoardList, title: 'My boards' },
  {
    path: ':boardId',
    loadComponent: () => import('./board-page/board-page').then((m) => m.BoardPage),
    title: 'Board',
  },
] satisfies Routes;
