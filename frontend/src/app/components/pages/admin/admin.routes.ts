import { Routes } from '@angular/router';

import { PluginAdmin } from './plugin-admin/plugin-admin';

/** Instance administration (router.ts guards it with adminGuard). */
export default [
  { path: '', pathMatch: 'full', redirectTo: 'plugins' },
  { path: 'plugins', component: PluginAdmin, title: 'Plugins' },
] satisfies Routes;
