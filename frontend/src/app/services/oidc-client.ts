import { InjectionToken } from '@angular/core';
import {
  InMemoryWebStorage,
  UserManager,
  UserManagerSettings,
  WebStorageStateStore,
} from 'oidc-client-ts';

import { RuntimeConfig } from './runtime-config';

/** The part of oidc-client-ts's UserManager that OidcAuth uses - small, so tests can fake it. */
export type OidcClient = Pick<
  UserManager,
  | 'getUser'
  | 'signinSilent'
  | 'signinRedirect'
  | 'signinRedirectCallback'
  | 'signoutRedirect'
  | 'removeUser'
  | 'metadataService'
>;

/** Full-page navigation (injectable so tests do not leave the page). */
export const NAVIGATE = new InjectionToken<(url: string) => void>('NAVIGATE', {
  providedIn: 'root',
  factory: () => (url) => window.location.assign(url),
});

export const OIDC_CLIENT = new InjectionToken<OidcClient>('OIDC_CLIENT');

/** Path the provider sends the browser back to after the login (handled before routing starts). */
export const CALLBACK_PATH = '/auth/callback';
/** Page that hands the result of a silent (prompt=none) request to the app, see public/. */
export const SILENT_RENEW_PATH = '/silent-renew.html';

/**
 * Authorization code flow with PKCE (S256, which oidc-client-ts always uses) against any OIDC
 * provider (discovery below the issuer). response_type is `code` only - no implicit, no hybrid
 * flow. redirect_uri and post_logout_redirect_uri are the exact values registered at the
 * provider (origin + fixed path), never taken from the URL.
 *
 *  - Tokens (the user) live in memory only: InMemoryWebStorage as userStore. A reload loses
 *    them, the silent sign-in at startup gets them back from the provider's session.
 *  - The state store keeps the short-lived login request (state, PKCE verifier) across the
 *    redirect to the provider, so it must survive a page load: sessionStorage. oidc-client-ts
 *    deletes the entry as soon as the callback is processed; it never holds tokens.
 *  - No automatic renewal timers: OidcAuth.token() renews on demand.
 */
export function createUserManager(
  config: RuntimeConfig,
  origin = window.location.origin,
  /** Tests only: e.g. a fixed `metadata` instead of the discovery request. */
  overrides: Partial<UserManagerSettings> = {},
): UserManager {
  return new UserManager({
    authority: config.oidcIssuer,
    client_id: config.oidcClientId,
    redirect_uri: `${origin}${CALLBACK_PATH}`,
    silent_redirect_uri: `${origin}${SILENT_RENEW_PATH}`,
    post_logout_redirect_uri: `${origin}/`,
    response_type: 'code',
    scope: config.oidcScope,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
    automaticSilentRenew: false,
    silentRequestTimeoutInSeconds: 5,
    // the user info endpoint is not needed: the app has its own profile (/api/users/me)
    loadUserInfo: false,
    ...overrides,
  });
}
