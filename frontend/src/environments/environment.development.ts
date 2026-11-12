import { DEFAULT_ABOUT_URL, DEFAULT_SOURCE_URL, Environment } from '../app/services/runtime-config';

/**
 * Local `ng serve` (angular.json fileReplacements, configuration "development") against the
 * backend dev stack: Keycloak on 18180 (realm drawboard), /api and /faro proxied by
 * proxy.conf.mjs. Faro stays off locally unless you add a `faro` block here.
 */
export const environment: Environment = {
  production: false,
  runtimeConfig: {
    environment: 'local',
    version: 'local',
    apiBaseUrl: '/api',
    oidcIssuer: 'http://localhost:18180/realms/drawboard',
    oidcClientId: 'drawboard-web',
    oidcScope: 'openid profile email',
    aboutUrl: DEFAULT_ABOUT_URL,
    sourceUrl: DEFAULT_SOURCE_URL,
  },
};
