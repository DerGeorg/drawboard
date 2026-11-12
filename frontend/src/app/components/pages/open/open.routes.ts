import { Routes } from '@angular/router';

import { OpenFromLink } from './open-from-link/open-from-link';

/**
 * Domain "open" - /open#v1.<data>: a board passed in a data URL (architecture 3.9, S5.6). Needs
 * the login (router.ts adds the authGuard).
 */
export default [{ path: '', component: OpenFromLink, title: 'Board from a link' }] satisfies Routes;
