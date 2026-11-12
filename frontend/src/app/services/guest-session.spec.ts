import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GuestSession as GuestSessionDto } from '@apps/drawboard-api';

import { provideFakeAuth } from '../test/fake-auth';
import { aProblem } from '../test/fixtures';
import { expectRequest, problemResponse, provideHttpTesting } from '../test/http-testing';
import { GuestSession, MAX_SESSION_MS, REFRESH_MARGIN_MS } from './guest-session';

const LINK_TOKEN = 'L'.repeat(43);

function aSession(overrides: Partial<GuestSessionDto> = {}, lifetimeMs = 900_000): GuestSessionDto {
  return {
    accessToken: 'jwt-1',
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
    kind: 'BOARD',
    id: 'board-1',
    role: 'EDITOR',
    name: 'Guesty',
    ...overrides,
  };
}

describe('GuestSession', () => {
  let session: GuestSession;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 's',
            children: [
              { path: '', children: [] },
              { path: 'b/:id', children: [] },
            ],
          },
        ]),
        provideHttpTesting(),
        provideFakeAuth().providers,
      ],
    });
    session = TestBed.inject(GuestSession);
  });

  afterEach(() => {
    session.clear();
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
  });

  /** Lets the pending HTTP request reach the testing backend. */
  const flushMicrotasks = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  describe('start', () => {
    it('when a session starts then the guest is known and the token is handed out', async () => {
      session.start(aSession(), LINK_TOKEN);

      expect(session.active(), 'active').toBe(true);
      expect(session.user(), 'user').toEqual({
        name: 'Guesty',
        role: 'EDITOR',
        kind: 'BOARD',
        id: 'board-1',
      });
      expect(await session.token(), 'token').toBe('jwt-1');
    });

    it('when no session exists then there is no token', async () => {
      expect(session.active(), 'active').toBe(false);
      expect(await session.token(), 'token').toBeUndefined();
    });

    it('when a new session starts then the end reason of the old one is forgotten', () => {
      session.end('limit');

      session.start(aSession(), LINK_TOKEN);

      expect(session.endedReason(), 'reason').toBeUndefined();
    });
  });

  describe('renewal', () => {
    it('when the token is about to expire then it is renewed by timer with the link token', async () => {
      session.start(aSession({}, 15 * 60_000), LINK_TOKEN);

      await vi.advanceTimersByTimeAsync(15 * 60_000 - REFRESH_MARGIN_MS);
      const request = expectRequest('POST', '/api/shares/refresh', 'renew guest session');
      expect(request.request.body, 'body').toEqual({ token: LINK_TOKEN });
      request.flush(aSession({ accessToken: 'jwt-2' }));
      await flushMicrotasks();

      expect(await session.token(), 'renewed token').toBe('jwt-2');
    });

    it('when a request needs the token shortly before it expires then it waits for the renewal', async () => {
      session.start(aSession({}, 30_000), LINK_TOKEN);

      const token = session.token();
      await flushMicrotasks();
      expectRequest('POST', '/api/shares/refresh').flush(aSession({ accessToken: 'jwt-2' }));

      expect(await token, 'token').toBe('jwt-2');
    });

    it('when the link was revoked (404) then the session ends with the reason revoked', async () => {
      session.start(aSession({}, 30_000), LINK_TOKEN);
      const token = session.token();
      await flushMicrotasks();

      expectRequest('POST', '/api/shares/refresh').flush(
        aProblem({ code: 'LIBRARY_SHARE_NOT_FOUND', status: 404 }),
        problemResponse(404, 'Not Found'),
      );

      expect(await token, 'token').toBeUndefined();
      expect(session.endedReason(), 'reason').toBe('revoked');
      expect(session.active(), 'active').toBe(false);
    });

    it.each([401, 403])(
      'when the renewal is refused with %i then the session ends as unauthorized, not as limit',
      async (status) => {
        session.start(aSession({}, 30_000), LINK_TOKEN);
        void session.token();
        await flushMicrotasks();

        expectRequest('POST', '/api/shares/refresh').flush(
          aProblem({ code: 'UNAUTHORIZED', status }),
          problemResponse(status, 'Refused'),
        );
        await flushMicrotasks();

        expect(session.endedReason(), 'reason').toBe('unauthorized');
      },
    );

    it('when the renewal fails for a moment and the token is still valid then it is tried again', async () => {
      session.start(aSession({}, 90_000), LINK_TOKEN);

      await vi.advanceTimersByTimeAsync(90_000 - REFRESH_MARGIN_MS);
      expectRequest('POST', '/api/shares/refresh', 'first try').flush(
        aProblem({ status: 503 }),
        problemResponse(503, 'Unavailable'),
      );
      await flushMicrotasks();
      expect(session.active(), 'still a guest').toBe(true);

      await vi.advanceTimersByTimeAsync(15_000);
      expectRequest('POST', '/api/shares/refresh', 'second try').flush(
        aSession({ accessToken: 'jwt-2' }),
      );
      await flushMicrotasks();

      expect(await session.token(), 'token').toBe('jwt-2');
    });

    it('when the renewal fails and the token has expired then the session ends as unauthorized', async () => {
      session.start(aSession({}, 20_000), LINK_TOKEN);
      await vi.advanceTimersByTimeAsync(5_000);
      vi.setSystemTime(Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expectRequest('POST', '/api/shares/refresh').flush(
        aProblem({ status: 500 }),
        problemResponse(500, 'Server Error'),
      );
      await flushMicrotasks();

      expect(session.endedReason(), 'reason').toBe('unauthorized');
    });

    it('when 12 hours have passed since the first exchange then the session ends without a request', async () => {
      session.start(aSession({}, MAX_SESSION_MS + 3_600_000), LINK_TOKEN);

      await vi.advanceTimersByTimeAsync(MAX_SESSION_MS);

      expect(session.endedReason(), 'reason').toBe('limit');
      expect(session.active(), 'active').toBe(false);
    });
  });

  describe('clear and end', () => {
    it('when cleared then the secrets are gone and the timer does not fire', async () => {
      session.start(aSession({}, 15 * 60_000), LINK_TOKEN);

      session.clear();
      await vi.advanceTimersByTimeAsync(20 * 60_000);

      expect(await session.token(), 'token').toBeUndefined();
      expect(session.endedReason(), 'reason').toBeUndefined();
    });

    it('when the session ends under a guest page then the join page opens', async () => {
      const router = TestBed.inject(Router);
      await router.navigateByUrl('/s/b/board-1');
      session.start(aSession(), LINK_TOKEN);

      session.end('limit');
      TestBed.tick();
      await flushMicrotasks();

      expect(router.url, 'URL').toBe('/s');
    });
  });
});
