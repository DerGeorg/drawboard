import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

import { FakeAuth, provideFakeAuth } from '../test/fake-auth';
import { authGuard } from './auth-guard';

describe('authGuard', () => {
  let auth: FakeAuth;

  function activate(url: string): Promise<unknown> {
    return TestBed.runInInjectionContext(() =>
      authGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    ) as Promise<unknown>;
  }

  beforeEach(() => {
    const fake = provideFakeAuth();
    auth = fake.auth;
    TestBed.configureTestingModule({ providers: [fake.providers] });
  });

  describe('canActivate', () => {
    it('when the user is signed in then the route is allowed without a login', async () => {
      auth.signIn('bob');

      expect(await activate('/boards'), 'guard result').toBe(true);
      expect(auth.loginCalls, 'login calls').toEqual([]);
    });

    it('when nobody is signed in then the login starts with the requested URL', async () => {
      expect(await activate('/boards/new'), 'guard result').toBe(false);
      expect(auth.loginCalls, 'login calls').toEqual(['/boards/new']);
    });
  });
});
