import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { GrantRole, ShareResourceKind } from '@apps/drawboard-api';

import { FakeAuth, provideFakeAuth } from '../test/fake-auth';
import { aProblem } from '../test/fixtures';
import { expectRequest, problemResponse, provideHttpTesting, settle } from '../test/http-testing';
import { THEME_STORAGE_KEY } from '../util/theme-mode';
import { Theme } from './theme';

/** `prefers-color-scheme: dark` as a test can steer it, including the change event. */
function stubSystem(dark: boolean): { change(dark: boolean): void } {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    change(next: boolean): void {
      query.matches = next;
      listeners.forEach((listener) => listener({ matches: next }));
    },
  };
}

describe('Theme', () => {
  let auth: FakeAuth;

  function create(): Theme {
    const fake = provideFakeAuth();
    auth = fake.auth;
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers],
    });
    return TestBed.inject(Theme);
  }

  const attribute = (): string | undefined => document.documentElement.dataset['theme'];

  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('System', () => {
    it('when nothing was chosen then System follows a light operating system', () => {
      stubSystem(false);

      const theme = create();

      expect(theme.mode(), 'mode').toBe('SYSTEM');
      expect(theme.resolved(), 'resolved').toBe('light');
      expect(attribute(), 'no attribute for System').toBeUndefined();
    });

    it('when the operating system is dark then System resolves to dark', () => {
      stubSystem(true);

      expect(create().resolved(), 'resolved').toBe('dark');
    });

    it('when the operating system switches while the app is open then System follows', () => {
      const system = stubSystem(false);
      const theme = create();

      system.change(true);
      expect(theme.resolved(), 'after dark').toBe('dark');
      system.change(false);
      expect(theme.resolved(), 'after light').toBe('light');
    });

    it('when the browser has no matchMedia then System is light', () => {
      vi.stubGlobal('matchMedia', undefined);

      expect(create().resolved(), 'resolved').toBe('light');
    });

    it('when a fixed mode is chosen then the operating system no longer matters', async () => {
      const system = stubSystem(true);
      const theme = create();

      await theme.set('LIGHT');
      system.change(true);

      expect(theme.resolved(), 'resolved').toBe('light');
    });
  });

  describe('set', () => {
    it('when Dark is chosen then data-theme is dark and the choice is cached', async () => {
      stubSystem(false);
      const theme = create();

      await theme.set('DARK');

      expect(theme.mode(), 'mode').toBe('DARK');
      expect(theme.resolved(), 'resolved').toBe('dark');
      expect(attribute(), 'attribute').toBe('dark');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY), 'cache').toBe('DARK');
    });

    it('when Light is chosen on a dark system then data-theme is light', async () => {
      stubSystem(true);
      const theme = create();

      await theme.set('LIGHT');

      expect(theme.resolved(), 'resolved').toBe('light');
      expect(attribute(), 'attribute').toBe('light');
    });

    it('when System is chosen again then the attribute is removed', async () => {
      stubSystem(false);
      const theme = create();
      await theme.set('DARK');

      await theme.set('SYSTEM');

      expect(attribute(), 'attribute').toBeUndefined();
      expect(window.localStorage.getItem(THEME_STORAGE_KEY), 'cache').toBe('SYSTEM');
    });
  });

  describe('the browser cache', () => {
    it('when a choice is cached then the service starts with it', () => {
      stubSystem(false);
      window.localStorage.setItem(THEME_STORAGE_KEY, 'DARK');

      const theme = create();

      expect(theme.mode(), 'mode').toBe('DARK');
      expect(attribute(), 'attribute').toBe('dark');
    });

    it('when the cached value is invalid then it is ignored', () => {
      stubSystem(false);
      window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');

      expect(create().mode(), 'mode').toBe('SYSTEM');
    });

    it('when the storage is blocked then the theme still works for this visit', async () => {
      stubSystem(false);
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      const theme = create();

      await theme.set('DARK');

      expect(theme.resolved(), 'resolved').toBe('dark');
    });
  });

  describe('signed out and guests', () => {
    it('when nobody is signed in then choosing makes no API call', async () => {
      stubSystem(false);
      const theme = create();

      await theme.set('DARK');

      // verify() in afterEach fails on any request
      expect(theme.mode(), 'mode').toBe('DARK');
    });

    it('when a guest chooses then it stays in the browser and never reaches the API', async () => {
      stubSystem(false);
      const theme = create();
      auth.signInAsGuest({
        name: 'Guesty',
        role: GrantRole.EDITOR,
        kind: ShareResourceKind.BOARD,
        id: 'b1',
      });

      await theme.set('DARK');

      expect(theme.mode(), 'mode').toBe('DARK');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY), 'cache').toBe('DARK');
    });
  });

  describe('a signed-in user', () => {
    it('when the profile has a saved choice then it wins over the browser cache', () => {
      stubSystem(false);
      window.localStorage.setItem(THEME_STORAGE_KEY, 'LIGHT');
      const theme = create();

      auth.signIn('alice', 'Alice Admin', false, false, 'DARK');
      TestBed.tick();

      expect(theme.mode(), 'mode').toBe('DARK');
      expect(attribute(), 'attribute').toBe('dark');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY), 'cache follows the server').toBe(
        'DARK',
      );
    });

    it('when the profile says System then the cached Dark is replaced', () => {
      stubSystem(false);
      window.localStorage.setItem(THEME_STORAGE_KEY, 'DARK');
      const theme = create();

      auth.signIn('alice');
      TestBed.tick();

      expect(theme.mode(), 'mode').toBe('SYSTEM');
      expect(attribute(), 'attribute').toBeUndefined();
    });

    it('when the user chooses then the mode applies at once and the preferences are saved', async () => {
      stubSystem(false);
      const theme = create();
      auth.signIn('alice');
      TestBed.tick();

      const saved = theme.set('DARK');

      expect(theme.mode(), 'applied before the answer').toBe('DARK');
      await settle();
      const request = expectRequest('PUT', '/api/users/me/preferences', 'save the theme');
      expect(request.request.body, 'body').toEqual({ theme: 'DARK' });
      request.flush({ theme: 'DARK' });
      await saved;
      expect(theme.mode(), 'mode after the answer').toBe('DARK');
    });

    it('when saving fails then the mode falls back to what the server holds', async () => {
      stubSystem(false);
      const theme = create();
      auth.signIn('alice', 'Alice Admin', false, false, 'LIGHT');
      TestBed.tick();

      const saved = theme.set('DARK');
      await settle();
      expectRequest('PUT', '/api/users/me/preferences', 'save the theme').flush(
        aProblem(),
        problemResponse(500, 'Internal Server Error'),
      );
      await saved;

      expect(theme.mode(), 'mode').toBe('LIGHT');
      expect(attribute(), 'attribute').toBe('light');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY), 'cache').toBe('LIGHT');
    });

    it('when a second choice is made while the first save fails then the newer choice stays', async () => {
      stubSystem(false);
      const theme = create();
      auth.signIn('alice', 'Alice Admin', false, false, 'LIGHT');
      TestBed.tick();

      const first = theme.set('DARK');
      await settle();
      const firstRequest = expectRequest('PUT', '/api/users/me/preferences', 'first save');
      const second = theme.set('SYSTEM');
      await settle();
      const secondRequest = expectRequest('PUT', '/api/users/me/preferences', 'second save');
      firstRequest.flush(aProblem(), problemResponse(500, 'Internal Server Error'));
      secondRequest.flush({ theme: 'SYSTEM' });
      await Promise.all([first, second]);

      expect(theme.mode(), 'mode').toBe('SYSTEM');
    });
  });
});
