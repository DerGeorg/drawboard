import { TestBed } from '@angular/core/testing';

import { CALLBACK_PATH, NAVIGATE, SILENT_RENEW_PATH, createUserManager } from './oidc-client';
import { TEST_RUNTIME_CONFIG } from '../test/runtime-config';

describe('createUserManager', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  describe('settings', () => {
    it('when created then it speaks the authorization code flow with the configured client', () => {
      const { settings } = createUserManager(TEST_RUNTIME_CONFIG, 'http://app.test');

      expect(settings.authority, 'authority').toBe('http://idp.test/realms/test');
      expect(settings.client_id, 'client id').toBe('app-web');
      expect(settings.response_type, 'response type').toBe('code');
      expect(settings.scope, 'scope').toBe('openid profile email');
    });

    it('when created for an origin then redirect, silent and logout URLs are below it', () => {
      const { settings } = createUserManager(TEST_RUNTIME_CONFIG, 'http://app.test');

      expect(settings.redirect_uri, 'redirect URI').toBe(`http://app.test${CALLBACK_PATH}`);
      expect(settings.silent_redirect_uri, 'silent redirect URI').toBe(
        `http://app.test${SILENT_RENEW_PATH}`,
      );
      expect(settings.post_logout_redirect_uri, 'post logout redirect URI').toBe(
        'http://app.test/',
      );
    });

    it('when a login request is built then it is code + PKCE S256 with the exact redirect URI', async () => {
      const manager = createUserManager(TEST_RUNTIME_CONFIG, 'http://app.test', {
        metadata: {
          issuer: 'http://idp.test/realms/test',
          authorization_endpoint: 'http://idp.test/realms/test/auth',
        },
      });

      // the request builder sits below the public API: it is what signinRedirect() sends
      const client = (
        manager as unknown as {
          _client: { createSigninRequest(args: object): Promise<{ url: string }> };
        }
      )._client;

      const url = new URL((await client.createSigninRequest({ request_type: 'si:r' })).url);

      expect(url.searchParams.get('response_type'), 'response_type').toBe('code');
      expect(url.searchParams.get('code_challenge_method'), 'code_challenge_method').toBe('S256');
      expect(url.searchParams.get('code_challenge'), 'code_challenge').toBeTruthy();
      expect(url.searchParams.get('redirect_uri'), 'redirect_uri').toBe(
        'http://app.test/auth/callback',
      );
      expect(url.searchParams.get('response_mode'), 'response_mode (no fragment)').not.toBe(
        'fragment',
      );
      expect(url.searchParams.get('client_id'), 'client_id').toBe('app-web');
    });

    it('when created then no renewal timer runs', () => {
      expect(
        createUserManager(TEST_RUNTIME_CONFIG).settings.automaticSilentRenew,
        'automatic silent renew',
      ).toBe(false);
    });
  });

  describe('storage', () => {
    it('when a user is stored then it lives in memory and not in any browser storage', async () => {
      const { settings } = createUserManager(TEST_RUNTIME_CONFIG);

      await settings.userStore.set('user', '{"access_token":"secret"}');

      expect(await settings.userStore.get('user'), 'user from the store').toContain('secret');
      expect(window.localStorage.length, 'entries in localStorage').toBe(0);
      expect(window.sessionStorage.length, 'entries in sessionStorage').toBe(0);
    });

    it('when a login request is stored then it survives in sessionStorage for the redirect', async () => {
      const { settings } = createUserManager(TEST_RUNTIME_CONFIG);

      await settings.stateStore.set('state', '{"verifier":"v"}');

      expect(window.sessionStorage.length, 'entries in sessionStorage').toBe(1);
      expect(window.localStorage.length, 'entries in localStorage').toBe(0);
    });
  });

  describe('NAVIGATE', () => {
    it('when injected then it is a function', () => {
      expect(typeof TestBed.inject(NAVIGATE), 'navigate function').toBe('function');
    });
  });
});
