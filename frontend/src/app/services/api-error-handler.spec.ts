import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { CollabService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { FakeAuth, provideFakeAuth, signedInAsAlice } from '../test/fake-auth';
import { aProblem } from '../test/fixtures';
import { expectRequest, problemResponse, provideHttpTesting, settle } from '../test/http-testing';
import { ApiError } from '../util/api-error';
import { Problem, toApiError } from '../util/api-error';
import { ApiErrorHandler } from './api-error-handler';
import { GuestSession } from './guest-session';
import { Toasts } from './toasts';

function apiError(problem: Partial<Problem>) {
  return toApiError(
    new HttpErrorResponse({
      status: problem.status,
      error: aProblem(problem),
      headers: new HttpHeaders(),
    }),
  );
}

describe('ApiErrorHandler', () => {
  let handler: ApiErrorHandler;
  let auth: FakeAuth;
  let toasts: Toasts;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const fake = signedInAsAlice();
    auth = fake.auth;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 's', children: [] }]),
        provideHttpTesting(),
        fake.providers,
      ],
    });
    handler = TestBed.inject(ApiErrorHandler);
    toasts = TestBed.inject(Toasts);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  describe('handle', () => {
    it('when the backend answers 401 then the login starts and no toast is shown', () => {
      handler.handle(apiError({ code: 'UNAUTHORIZED', status: 401 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(auth.loginCalls, 'login calls with the current URL').toEqual(['/']);
      expect(toasts.toasts(), 'toasts').toEqual([]);
    });

    it('when the login is needed on a URL with a fragment then the fragment is not part of the return URL', async () => {
      await TestBed.inject(Router).navigateByUrl('/s#' + 'T'.repeat(43));

      handler.handle(apiError({ code: 'UNAUTHORIZED', status: 401 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(auth.loginCalls, 'login calls').toEqual(['/s']);
    });

    it('when a write is forbidden then a toast with the request id is shown and the page stays', () => {
      handler.handle(apiError({ code: 'FORBIDDEN', status: 403, requestId: 'req-403' }), {
        method: 'POST',
        fieldErrorsHandledLocally: false,
      });

      expect(toasts.toasts(), 'toasts').toEqual([
        expect.objectContaining({ kind: 'error', requestId: 'req-403' }),
      ]);
      expect(navigate, 'navigation').not.toHaveBeenCalled();
    });

    it('when a read is forbidden then the forbidden page is shown as well', () => {
      handler.handle(apiError({ code: 'FORBIDDEN', status: 403 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(navigate, 'navigation').toHaveBeenCalledWith(['/forbidden'], {
        skipLocationChange: true,
      });
      expect(toasts.toasts().length, 'toasts').toBe(1);
    });

    it('when a read finds nothing then the not-found page is shown as well', () => {
      handler.handle(apiError({ code: 'LIBRARY_BOARD_NOT_FOUND', status: 404 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(navigate, 'navigation').toHaveBeenCalledWith(['/not-found'], {
        skipLocationChange: true,
      });
      expect(toasts.toasts().length, 'toasts').toBe(1);
    });

    it('when a write finds nothing then only the toast is shown', () => {
      handler.handle(apiError({ code: 'LIBRARY_BOARD_NOT_FOUND', status: 404 }), {
        method: 'DELETE',
        fieldErrorsHandledLocally: false,
      });

      expect(navigate, 'navigation').not.toHaveBeenCalled();
      expect(toasts.toasts().length, 'toasts').toBe(1);
    });

    it('when a form shows the violations itself then nothing else happens', () => {
      const violations = [{ field: 'title', code: 'Pattern', message: 'must match' }];

      handler.handle(apiError({ code: 'VALIDATION_FAILED', status: 400, violations }), {
        method: 'POST',
        fieldErrorsHandledLocally: true,
      });

      expect(toasts.toasts(), 'toasts').toEqual([]);
    });

    it('when violations arrive without a form that shows them then they are toasted', () => {
      const violations = [{ field: 'title', code: 'Pattern', message: 'must match' }];

      handler.handle(apiError({ code: 'VALIDATION_FAILED', status: 400, violations }), {
        method: 'POST',
        fieldErrorsHandledLocally: false,
      });

      expect(
        toasts.toasts().map((t) => t.message),
        'toast texts',
      ).toEqual(['Some fields are invalid. Please check your input.']);
    });
  });

  describe('handle as a guest', () => {
    const guestSession = {
      accessToken: 'jwt',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      kind: 'BOARD',
      id: 'b',
      role: 'VIEWER',
      name: 'Guesty',
    } as const;

    it('when the guest token is refused (401) then the session ends and there is no login', () => {
      const session = TestBed.inject(GuestSession);
      session.start(guestSession, 'link');
      auth.signInAsGuest({ name: 'Guesty', role: 'VIEWER', kind: 'BOARD', id: 'b' });

      handler.handle(apiError({ code: 'UNAUTHORIZED', status: 401 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(session.endedReason(), 'reason').toBe('unauthorized');
      expect(auth.loginCalls, 'login calls').toEqual([]);
    });

    it('when a read is not found as a guest then only a toast is shown, not the login-protected page', () => {
      auth.signInAsGuest({ name: 'Guesty', role: 'VIEWER', kind: 'BOARD', id: 'b' });

      handler.handle(apiError({ code: 'NOT_FOUND', status: 404 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(toasts.toasts().length, 'toasts').toBe(1);
      expect(navigate, 'navigation').not.toHaveBeenCalled();
    });
  });

  describe('handle after the guest session ended', () => {
    beforeEach(() => {
      TestBed.resetTestingModule();
      const fake = provideFakeAuth();
      auth = fake.auth;
      TestBed.configureTestingModule({
        providers: [provideRouter([]), provideHttpTesting(), fake.providers],
      });
      handler = TestBed.inject(ApiErrorHandler);
      toasts = TestBed.inject(Toasts);
    });

    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('when the guest session already ended then a 401 neither logs in nor toasts', () => {
      const session = TestBed.inject(GuestSession);
      session.end('unauthorized');

      handler.handle(apiError({ code: 'UNAUTHORIZED', status: 401 }), {
        method: 'GET',
        fieldErrorsHandledLocally: false,
      });

      expect(auth.loginCalls, 'login calls').toEqual([]);
      expect(toasts.toasts(), 'toasts').toEqual([]);
    });

    it('when the collab ticket of a guest whose session ended is refused then there is no login', async () => {
      const session = TestBed.inject(GuestSession);
      session.end('limit');
      const ticket = firstValueFrom(
        TestBed.inject(CollabService).createCollabTicket({ boardId: 'b' }),
      ).catch((e: unknown) => e);
      await settle();

      expectRequest('POST', '/api/boards/b/collab-ticket').flush(
        aProblem({ code: 'UNAUTHORIZED', status: 401 }),
        problemResponse(401, 'Unauthorized'),
      );

      expect(await ticket, 'ticket rejection').toBeInstanceOf(ApiError);
      expect(auth.loginCalls, 'login calls').toEqual([]);
    });
  });
});
