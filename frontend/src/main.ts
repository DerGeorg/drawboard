// must stay the first import: the Trusted Types policies exist before any other code runs
import './trusted-types';

import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { RuntimeConfig, loadRuntimeConfig } from './app/services/runtime-config';
import { appConfig } from './config/config';
import { environment } from './environments/environment';
import { applyStoredTheme } from './app/util/theme-mode';

// the remembered theme before anything paints (no inline script: the CSP forbids it)
applyStoredTheme();

const runtimeConfig: Promise<RuntimeConfig> = environment.runtimeConfig
  ? Promise.resolve(environment.runtimeConfig)
  : loadRuntimeConfig('/config.json');

runtimeConfig
  .then((config) => bootstrapApplication(App, appConfig(config)))
  .catch((error: unknown) => {
    // Without config or login there is no app - say so instead of leaving a blank page.
    console.error(error);
    document.body.textContent = 'Drawboard could not start. Please reload the page in a moment.';
  });
