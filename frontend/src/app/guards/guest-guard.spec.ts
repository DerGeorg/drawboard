import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';

import { GuestSession } from '../services/guest-session';
import { provideFakeAuth } from '../test/fake-auth';
import { provideHttpTesting } from '../test/http-testing';
import { guestGuard } from './guest-guard';

describe('guestGuard', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), provideFakeAuth().providers],
    });
  });

  describe('canActivate', () => {
    it('when there is no guest session then the join page is the target', () => {
      const result = TestBed.runInInjectionContext(() => guestGuard({} as never, {} as never));

      expect(
        result instanceof UrlTree && TestBed.inject(Router).serializeUrl(result),
        'target',
      ).toBe('/s');
    });

    it('when a guest session exists then the page opens', () => {
      const session = TestBed.inject(GuestSession);
      session.start(
        {
          accessToken: 'jwt',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          kind: 'BOARD',
          id: 'b',
          role: 'VIEWER',
          name: 'G',
        },
        'link',
      );

      const result = TestBed.runInInjectionContext(() => guestGuard({} as never, {} as never));

      expect(result, 'result').toBe(true);
      session.clear();
    });
  });
});
