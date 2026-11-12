import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';

import { provideFakeAuth } from '../test/fake-auth';
import { adminGuard } from './admin-guard';

describe('adminGuard', () => {
  function run(admin: boolean | undefined): boolean | UrlTree {
    const auth = provideFakeAuth();
    if (admin !== undefined) {
      auth.auth.signIn('alice', 'Alice', admin);
    }
    TestBed.configureTestingModule({ providers: [provideRouter([]), auth.providers] });
    return TestBed.runInInjectionContext(() =>
      adminGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    ) as boolean | UrlTree;
  }

  describe('canActivate', () => {
    it('when an instance admin opens the page then it is shown', () => {
      expect(run(true), 'allowed').toBe(true);
    });

    it('when someone else opens it then the forbidden page is shown', () => {
      const result = run(false);

      expect(
        result instanceof UrlTree && TestBed.inject(Router).serializeUrl(result),
        'redirect',
      ).toBe('/forbidden');
    });

    it('when the profile is not loaded then it is not shown', () => {
      expect(run(undefined), 'redirect').toBeInstanceOf(UrlTree);
    });
  });
});
