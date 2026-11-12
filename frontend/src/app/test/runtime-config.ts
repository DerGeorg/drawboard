import { Provider } from '@angular/core';

import { RUNTIME_CONFIG, RuntimeConfig } from '../services/runtime-config';

export const TEST_RUNTIME_CONFIG: RuntimeConfig = {
  environment: 'test',
  version: '0.0.0-test',
  apiBaseUrl: '/api',
  oidcIssuer: 'http://idp.test/realms/test',
  oidcClientId: 'app-web',
  oidcScope: 'openid profile email',
  aboutUrl: 'https://about.test',
  sourceUrl: 'https://source.test/drawboard',
};

/** RUNTIME_CONFIG for tests; override only what the test is about. */
export function provideTestRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): Provider {
  return { provide: RUNTIME_CONFIG, useValue: { ...TEST_RUNTIME_CONFIG, ...overrides } };
}
