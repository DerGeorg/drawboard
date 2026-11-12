import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { FakeOidcClient, anOidcUser } from '../test/fake-oidc-client';
import { aCurrentUser, aProblem } from '../test/fixtures';
import { expectRequest, problemResponse, provideHttpTesting, settle } from '../test/http-testing';
import { Auth } from './auth';
import { GuestSession } from './guest-session';
import { NAVIGATE, OIDC_CLIENT } from './oidc-client';
import { OidcAuth, providerLogoutUrl } from './oidc-auth';
import { RUNTIME_CONFIG } from './runtime-config';
import { TEST_RUNTIME_CONFIG } from '../test/runtime-config';

describe('OidcAuth', () => {
  let client: FakeOidcClient;
  let auth: OidcAuth;
  let navigated: string[];

  function configure(): void {
    client = new FakeOidcClient();
    navigated = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpTesting(),
        { provide: OIDC_CLIENT, useValue: client },
        { provide: NAVIGATE, useValue: (url: string) => navigated.push(url) },
        { provide: RUNTIME_CONFIG, useValue: TEST_RUNTIME_CONFIG },
        OidcAuth,
        { provide: Auth, useExisting: OidcAuth },
      ],
    });
    auth = TestBed.inject(OidcAuth);
  }

  /** Runs start() and answers /api/users/me when the session was restored. */
  async function start(me: object | null = aCurrentUser()): Promise<void> {
    const started = auth.start();
    await settle();
    if (me) {
      expectRequest('GET', '/api/users/me', 'load profile').flush(me);
    }
    await started;
  }

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    configure();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    window.history.replaceState(null, '', '/');
  });

  describe('start', () => {
    it('when the silent sign-in works then the user is signed in with the profile of the backend', async () => {
      client.silentResults = [anOidcUser()];

      await start(aCurrentUser({ displayName: 'Alice Admin', admin: true }));

      expect(auth.authenticated(), 'authenticated').toBe(true);
      expect(auth.user(), 'user').toEqual({
        id: 'id-alice',
        username: 'alice',
        displayName: 'Alice Admin',
        admin: true,
        guestLinksEnabled: false,
      });
    });

    it('when the profile has no display name then the username is used', async () => {
      client.silentResults = [anOidcUser()];

      await start(aCurrentUser({ displayName: null }));

      expect(auth.user()?.displayName, 'display name').toBe('alice');
    });

    it('when the provider has no session then nobody is signed in and the backend is not called', async () => {
      client.silentResults = [null];

      await start(null);

      expect(auth.authenticated(), 'authenticated').toBe(false);
      expect(auth.user(), 'user').toBeNull();
    });

    it('when the silent sign-in fails then nobody is signed in', async () => {
      client.silentResults = [new Error('login_required')];
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await start(null);

      expect(auth.authenticated(), 'authenticated').toBe(false);
    });

    it('when the profile cannot be loaded then the session stays but there is no user', async () => {
      client.silentResults = [anOidcUser()];

      const started = auth.start();
      await settle();
      expectRequest('GET', '/api/users/me', 'load profile').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await started;

      expect(auth.authenticated(), 'authenticated').toBe(true);
      expect(auth.user(), 'user').toBeNull();
    });
  });

  describe('login redirect callback', () => {
    beforeEach(() => window.history.replaceState(null, '', '/auth/callback?code=c&state=s'));

    it('when the provider sends the browser back then the login is finished and the return URL restored', async () => {
      client.callbackResult = anOidcUser({ state: { returnUrl: '/boards?page=2' } });

      await start();

      expect(client.calls, 'oidc calls').toEqual(['signinRedirectCallback']);
      expect(auth.authenticated(), 'authenticated').toBe(true);
      expect(window.location.pathname + window.location.search, 'URL').toBe('/boards?page=2');
    });

    it.each(['https://evil.example/', '//evil.example/', 'boards', undefined])(
      'when the state carries the return URL %s then the root is used',
      async (returnUrl) => {
        client.callbackResult = anOidcUser({ state: { returnUrl } });

        await start();

        expect(window.location.pathname, 'URL path').toBe('/');
      },
    );

    it('when the callback fails then nobody is signed in and the root is shown', async () => {
      client.callbackResult = new Error('invalid state');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await start(null);

      expect(auth.authenticated(), 'authenticated').toBe(false);
      expect(window.location.pathname, 'URL path').toBe('/');
    });
  });

  describe('login', () => {
    it('when a path is given then the login request carries it as return URL', async () => {
      await auth.login('/boards/42');

      expect(client.calls, 'oidc calls').toEqual(['signinRedirect']);
      expect(client.loginArgs, 'login arguments').toEqual({ state: { returnUrl: '/boards/42' } });
    });

    it('when the path carries a fragment then the return URL has none', async () => {
      await auth.login('/s#' + 'T'.repeat(43));

      expect(client.loginArgs, 'login arguments').toEqual({ state: { returnUrl: '/s' } });
    });

    it('when no path is given then the current page is the return URL', async () => {
      window.history.replaceState(null, '', '/boards?page=3');

      await auth.login();

      expect(client.loginArgs, 'login arguments').toEqual({
        state: { returnUrl: '/boards?page=3' },
      });
    });
  });

  describe('logout', () => {
    it('when signing out then the provider ends the session and the local state is cleared', async () => {
      client.silentResults = [anOidcUser()];
      await start();

      await auth.logout();

      expect(client.calls, 'oidc calls').toEqual(['signinSilent', 'signoutRedirect']);
      expect(auth.authenticated(), 'authenticated').toBe(false);
      expect(auth.user(), 'user').toBeNull();
    });

    it('when the provider has no end-session endpoint then its own logout page ends the session', async () => {
      client.silentResults = [anOidcUser()];
      await start();
      client.endSessionEndpoint = undefined;

      await auth.logout();

      expect(client.calls, 'oidc calls').toEqual(['signinSilent', 'removeUser']);
      expect(navigated, 'navigations').toEqual([
        `http://idp.test/realms/test/logout?rd=${encodeURIComponent(`${window.location.origin}/`)}`,
      ]);
      expect(auth.authenticated(), 'authenticated').toBe(false);
    });

    it('when signing out at the provider fails then the local session is removed and the root is opened', async () => {
      client.silentResults = [anOidcUser()];
      await start();
      client.signoutError = new Error('provider unreachable');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await auth.logout();

      expect(client.calls, 'oidc calls').toEqual(['signinSilent', 'signoutRedirect', 'removeUser']);
      expect(navigated, 'navigations').toEqual(['/']);
      expect(auth.authenticated(), 'authenticated').toBe(false);
    });

    it('when the discovery cannot be read then the local session is removed and the root is opened', async () => {
      client.silentResults = [anOidcUser()];
      await start();
      client.endSessionEndpoint = new Error('discovery failed');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await auth.logout();

      expect(client.calls, 'oidc calls').toEqual(['signinSilent', 'removeUser']);
      expect(navigated, 'navigations').toEqual(['/']);
    });
  });

  describe('providerLogoutUrl', () => {
    it('when the issuer has a trailing slash then the logout URL has none twice and rd is encoded', () => {
      expect(providerLogoutUrl('https://sso.example.org/', 'https://app.example.org'), 'url').toBe(
        'https://sso.example.org/logout?rd=https%3A%2F%2Fapp.example.org%2F',
      );
    });
  });

  describe('guest mode', () => {
    it('when a guest session is active then token() is the guest token and the OIDC client is not asked', async () => {
      TestBed.inject(GuestSession).start(
        {
          accessToken: 'guest-jwt',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          kind: 'BOARD',
          id: 'b',
          role: 'VIEWER',
          name: 'Guesty',
        },
        'link',
      );

      expect(await auth.token(), 'token').toBe('guest-jwt');
      expect(auth.guest()?.name, 'guest').toBe('Guesty');
      expect(client.calls, 'oidc calls').toEqual([]);
      TestBed.inject(GuestSession).clear();
    });
  });

  describe('token', () => {
    it('when nobody is signed in then there is no token', async () => {
      expect(await auth.token(), 'token').toBeUndefined();
    });

    it('when the token is valid long enough then it is returned without renewing', async () => {
      client.silentResults = [anOidcUser({ access_token: 'access-1', expires_in: 3600 })];
      await start();

      expect(await auth.token(), 'token').toBe('access-1');
      expect(client.calls, 'oidc calls').toEqual(['signinSilent']);
    });

    it('when the token expires within the requested validity then it is renewed once for concurrent callers', async () => {
      client.silentResults = [
        anOidcUser({ access_token: 'access-1', expires_in: 3600 }),
        anOidcUser({ access_token: 'access-2', expires_in: 3600 }),
      ];
      await start();

      const tokens = await Promise.all([auth.token(7200), auth.token(7200)]);

      expect(tokens, 'tokens').toEqual(['access-2', 'access-2']);
      expect(client.calls, 'oidc calls').toEqual(['signinSilent', 'signinSilent']);
    });

    it('when the renewal fails then there is no token and the session is over', async () => {
      client.silentResults = [anOidcUser({ expires_in: 3600 }), new Error('login_required')];
      await start();

      expect(await auth.token(7200), 'token').toBeUndefined();
      expect(auth.authenticated(), 'authenticated').toBe(false);
      expect(auth.user(), 'user').toBeNull();
    });

    it('when the renewal finds no session then there is no token', async () => {
      client.silentResults = [anOidcUser({ expires_in: 3600 }), null];
      await start();

      expect(await auth.token(7200), 'token').toBeUndefined();
    });
  });
});
