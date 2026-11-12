import { Routes } from '@angular/router';

import { Forbidden } from './forbidden/forbidden';
import { NotFound } from './not-found/not-found';

/**
 * Error pages. Mounted last in router.ts: the wildcard catches every unknown URL.
 * /forbidden and /not-found are also shown without changing the URL (403 on a read, ApiErrorHandler).
 */
export default [
  { path: 'forbidden', component: Forbidden, title: 'No permission' },
  { path: '**', component: NotFound, title: 'Not found' },
] satisfies Routes;
