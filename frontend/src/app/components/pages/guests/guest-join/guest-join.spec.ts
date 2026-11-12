import { BrowserPlatformLocation, PlatformLocation } from '@angular/common';
import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, Routes, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ShareAccess } from '@apps/drawboard-api';

import { GuestSession } from '../../../../services/guest-session';
import { Toasts } from '../../../../services/toasts';
import { all, buttonByText, textOf, typeInto } from '../../../../test/dom';
import { FakeAuth, provideFakeAuth } from '../../../../test/fake-auth';
import { aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { GuestJoin } from './guest-join';

const TOKEN = 'T'.repeat(43);

const guestAccess: ShareAccess = {
  kind: 'BOARD',
  id: 'board-1',
  role: 'EDITOR',
  guestSession: {
    accessToken: 'guest-jwt',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    kind: 'BOARD',
    id: 'board-1',
    role: 'EDITOR',
    name: 'Guesty',
  },
};

/** The /s routes as in guests.routes.ts, the guest views as empty stand-ins. */
const ROUTES: Routes = [
  {
    path: 's',
    children: [
      { path: '', component: GuestJoin },
      { path: 'b/:id', children: [] },
      { path: 'f/:id', children: [] },
    ],
  },
  { path: 'boards', children: [] },
];

/** The tests of the testing module mock the address bar; these look at the real one. */
const REAL_LOCATION = { provide: PlatformLocation, useClass: BrowserPlatformLocation };

describe('GuestJoin', () => {
  let fixture: ComponentFixture<unknown>;
  let auth: FakeAuth;
  let navigate: ReturnType<typeof vi.spyOn>;
  let session: GuestSession;
  let configured = false;

  /**
   * Opens `/s` with this fragment through the router, as a click on a link does. Further
   * navigations are replaced by a spy unless `realNavigation` is set.
   */
  async function render(
    hash = `#${TOKEN}`,
    signedIn = false,
    realNavigation = false,
  ): Promise<void> {
    configured = true;
    const fake = provideFakeAuth();
    auth = fake.auth;
    if (signedIn) {
      auth.signIn('alice', 'Alice Admin');
    }
    TestBed.configureTestingModule({
      providers: [REAL_LOCATION, provideRouter(ROUTES), provideHttpTesting(), fake.providers],
    });
    const router = TestBed.inject(Router);
    session = TestBed.inject(GuestSession);
    // the harness renders the router outlet; navigations go through the router itself
    fixture = (await RouterTestingHarness.create()).fixture;
    navigate = vi.spyOn(router, 'navigate');
    if (realNavigation) {
      // the app's initial navigation does this: popstate events reach the router
      router.setUpLocationChangeListener();
    } else {
      navigate.mockResolvedValue(true);
    }
    await router.navigateByUrl(`/s${hash}`);
    await settle();
  }

  /** The pending exchange request. */
  const exchange = (): ReturnType<typeof expectRequest> =>
    expectRequest('POST', '/api/shares/exchange', 'exchange the token');

  async function reject(status: number, code: string, extra: object = {}): Promise<void> {
    exchange().flush(
      aProblem({ status, code, requestId: 'req-x', ...extra }),
      problemResponse(status, 'Error', 'req-x'),
    );
    await settle();
    await fixture.whenStable();
  }

  afterEach(() => {
    if (configured) {
      TestBed.inject(HttpTestingController).verify();
      session.clear();
    }
    configured = false;
    window.history.replaceState(null, '', '/');
  });

  describe('the link token', () => {
    it('when opened with a token then the fragment is removed from the address bar at once', async () => {
      await render();

      expect(window.location.hash, 'fragment').toBe('');
      expect(window.location.href, 'URL').not.toContain(TOKEN);
      exchange().flush(guestAccess);
    });

    it('when opened then the token is sent in the request body and stored nowhere', async () => {
      await render();

      const request = exchange();
      expect(request.request.body, 'body').toEqual({ token: TOKEN });
      expect(request.request.url, 'URL has no token').not.toContain(TOKEN);
      request.flush(guestAccess);
      await settle();
      expect(JSON.stringify(window.localStorage), 'localStorage').not.toContain(TOKEN);
      expect(JSON.stringify(window.sessionStorage), 'sessionStorage').not.toContain(TOKEN);
      expect(document.cookie, 'cookies').not.toContain(TOKEN);
    });

    it('when the page is opened without a fragment then it asks to open a link', async () => {
      await render('');

      expect(textOf(fixture), 'text').toContain('Open a share link');
    });

    it('when a signed-in visitor opens the page without a link then a way to the boards is offered', async () => {
      await render('', true);

      expect(all(fixture, 'a[href$="/boards"]').length, 'link to the library').toBe(1);
    });

    it('when opened with a token then the router URL and the history entry keep no fragment', async () => {
      await render(`#${TOKEN}`, false, true);

      expect(window.location.hash, 'fragment').toBe('');
      expect(TestBed.inject(Router).url, 'router URL').toBe('/s');
      const request = exchange();
      expect(request.request.body, 'body').toEqual({ token: TOKEN });
      expect(textOf(fixture), 'the clearing navigation is no reset').not.toContain(
        'Open a share link',
      );
      request.flush(guestAccess);
      await settle();
    });

    it('when a link is pasted into the address bar while the page is open then it is opened and the fragment does not come back', async () => {
      const token2 = 'U'.repeat(43);
      await render('', false, true);
      expect(textOf(fixture), 'text before').toContain('Open a share link');

      // what the browser does for a pasted link: pushState, popstate, then hashchange
      window.history.pushState(null, '', `/s#${token2}`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await new Promise((resolve) => setTimeout(resolve));
      await settle();
      await new Promise((resolve) => setTimeout(resolve));
      await settle();

      expect(window.location.hash, 'fragment').toBe('');
      expect(TestBed.inject(Router).url, 'router URL').toBe('/s');
      const request = exchange();
      expect(request.request.body, 'body').toEqual({ token: token2 });
      request.flush(guestAccess);
      await settle();
    });

    it('when the token has the wrong shape then the link is called invalid without a request', async () => {
      await render('#short');

      expect(all(fixture, '[data-testid=invalid]').length, 'invalid text').toBe(1);
    });

    it('when a guest opens the page again then the old guest session is dropped before the exchange', async () => {
      configured = true;
      const fake = provideFakeAuth();
      TestBed.configureTestingModule({
        providers: [REAL_LOCATION, provideRouter(ROUTES), provideHttpTesting(), fake.providers],
      });
      session = TestBed.inject(GuestSession);
      session.start(guestAccess.guestSession!, 'old-link-token');
      const router = TestBed.inject(Router);
      vi.spyOn(router, 'navigate').mockResolvedValue(true);
      // the harness renders the router outlet; navigations go through the router itself
      fixture = (await RouterTestingHarness.create()).fixture;
      await router.navigateByUrl(`/s#${TOKEN}`);
      await settle();

      expect(session.active(), 'guest mode while exchanging').toBe(false);
      exchange().flush(guestAccess);
    });
  });

  describe('success', () => {
    it('when an anonymous visitor opens a guest link then guest mode starts and the board opens', async () => {
      await render();
      exchange().flush(guestAccess);
      await settle();

      expect(session.user()?.name, 'guest name').toBe('Guesty');
      expect(await session.token(), 'guest token in memory').toBe('guest-jwt');
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/s', 'b', 'board-1'], {
        replaceUrl: true,
      });
    });

    it('when the link opens a folder for a guest then the folder view opens', async () => {
      await render();
      exchange().flush({
        ...guestAccess,
        kind: 'FOLDER',
        id: 'folder-1',
        guestSession: { ...guestAccess.guestSession!, kind: 'FOLDER', id: 'folder-1' },
      });
      await settle();

      expect(navigate, 'navigation').toHaveBeenCalledWith(['/s', 'f', 'folder-1'], {
        replaceUrl: true,
      });
    });

    it('when a signed-in visitor opens a board link then no guest mode starts and the board opens', async () => {
      await render(`#${TOKEN}`, true);
      exchange().flush({ kind: 'BOARD', id: 'board-1', role: 'VIEWER' });
      await settle();

      expect(session.active(), 'guest mode').toBe(false);
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', 'board-1'], {
        replaceUrl: true,
      });
    });

    it('when a signed-in visitor opens a folder link then the shared folder opens in the library', async () => {
      await render(`#${TOKEN}`, true);
      exchange().flush({ kind: 'FOLDER', id: 'folder-1', role: 'VIEWER' });
      await settle();

      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards'], {
        queryParams: { view: 'shared', folder: 'folder-1' },
        replaceUrl: true,
      });
    });
  });

  describe('failures', () => {
    it('when the link is unknown, revoked or expired (404) then "invalid or expired" is shown and no toast', async () => {
      await render();

      await reject(404, 'LIBRARY_SHARE_NOT_FOUND');

      expect(textOf(fixture), 'text').toContain('The link is invalid or expired');
      expect(TestBed.inject(Toasts).toasts(), 'toasts').toEqual([]);
    });

    it('when too many attempts were made (429) then the wait time from Retry-After is shown and Try again asks again', async () => {
      await render();
      exchange().flush(aProblem({ status: 429, code: 'TOO_MANY_REQUESTS' }), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '30' },
      });
      await settle();
      await fixture.whenStable();
      expect(textOf(fixture), 'wait message').toContain('Please wait 30 seconds');

      buttonByText(fixture, 'Try again').click();
      await settle();
      exchange().flush(guestAccess);
    });

    it('when there is no Retry-After then "a moment" is shown', async () => {
      await render();

      await reject(429, 'TOO_MANY_REQUESTS');

      expect(textOf(fixture), 'wait message').toContain('Please wait a moment');
    });

    it('when anything else goes wrong then the request id is shown', async () => {
      await render();

      await reject(500, 'INTERNAL_ERROR');

      expect(textOf(fixture), 'text').toContain('Request id: req-x');
    });
  });

  describe('password', () => {
    it('when the link needs a password then the form is shown and the password goes in the body', async () => {
      await render();
      await reject(403, 'LIBRARY_SHARE_PASSWORD_REQUIRED');
      expect(textOf(fixture), 'prompt').toContain('This link is protected');

      typeInto(fixture, '#join-password', 'secret-pass');
      await fixture.whenStable();
      buttonByText(fixture, 'Open').click();
      await settle();
      const retry = exchange();
      expect(retry.request.body, 'body').toEqual({ token: TOKEN, password: 'secret-pass' });
      retry.flush(guestAccess);
      await settle();

      expect(session.active(), 'guest mode').toBe(true);
    });

    it('when the password is wrong then the form comes back with a message and an empty field', async () => {
      await render();
      await reject(403, 'LIBRARY_SHARE_PASSWORD_REQUIRED');
      typeInto(fixture, '#join-password', 'wrong-pass');
      await fixture.whenStable();
      buttonByText(fixture, 'Open').click();
      await settle();

      await reject(403, 'LIBRARY_SHARE_PASSWORD_INVALID');

      expect(all(fixture, '[data-testid=wrong-password]').length, 'message').toBe(1);
      expect(all<HTMLInputElement>(fixture, '#join-password')[0].value, 'field').toBe('');
    });

    it('when the password is empty then it is asked for and nothing is sent', async () => {
      await render();
      await reject(403, 'LIBRARY_SHARE_PASSWORD_REQUIRED');

      buttonByText(fixture, 'Open').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'error').toContain('Enter the password.');
    });
  });

  describe('guest name', () => {
    const nameViolation = {
      status: 400,
      code: 'VALIDATION_FAILED',
      violations: [{ field: 'guestName', code: 'NotBlank', message: 'blank' }],
    };

    it('when the link is for guests and no name was sent then the name form is shown and the name goes in the body', async () => {
      await render();
      await reject(400, 'VALIDATION_FAILED', nameViolation);
      expect(textOf(fixture), 'prompt').toContain('Join as a guest');

      typeInto(fixture, '#join-name', '  Guesty  ');
      await fixture.whenStable();
      buttonByText(fixture, 'Join').click();
      await settle();
      const retry = exchange();
      expect(retry.request.body, 'body').toEqual({ token: TOKEN, guestName: 'Guesty' });
      retry.flush(guestAccess);
      await settle();

      expect(session.active(), 'guest mode').toBe(true);
    });

    it('when the server rejects the name then a message asks for another one', async () => {
      await render();
      await reject(400, 'VALIDATION_FAILED', nameViolation);
      typeInto(fixture, '#join-name', 'x');
      await fixture.whenStable();
      buttonByText(fixture, 'Join').click();
      await settle();

      await reject(400, 'VALIDATION_FAILED', nameViolation);

      expect(all(fixture, '[data-testid=name-rejected]').length, 'message').toBe(1);
    });

    it('when the name is blank then it is asked for and nothing is sent', async () => {
      await render();
      await reject(400, 'VALIDATION_FAILED', nameViolation);

      typeInto(fixture, '#join-name', '   ');
      await fixture.whenStable();
      buttonByText(fixture, 'Join').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'error').toContain('Enter a name.');
    });
  });

  describe('sign-in required', () => {
    it('when the link is for signed-in users then Sign in starts the login and says to open the link again', async () => {
      await render();
      await reject(401, 'LIBRARY_SHARE_LOGIN_REQUIRED');
      expect(textOf(fixture), 'text').toContain('open the link again');

      buttonByText(fixture, 'Sign in').click();
      await settle();

      expect(auth.loginCalls, 'login calls with the plain /s path - no token').toEqual(['/s']);
    });
  });

  describe('a session that ended', () => {
    it.each([
      ['limit', 'ended after 12 hours'],
      ['revoked', 'revoked or has expired'],
      ['unauthorized', 'no longer valid'],
    ] as const)('when the reason is %s then the page says so', async (reason, text) => {
      await render('');

      session.end(reason);
      await fixture.whenStable();

      expect(textOf(fixture), 'message').toContain(text);
    });
  });
});
