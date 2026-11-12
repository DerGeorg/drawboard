import { HttpClient, HttpContext } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { signedInAsAlice } from '../test/fake-auth';
import { aProblem } from '../test/fixtures';
import { expectRequest, problemResponse, provideHttpTesting, settle } from '../test/http-testing';
import { ApiError } from '../util/api-error';
import { ApiErrorContext, ApiErrorHandler } from './api-error-handler';
import { ERRORS_HANDLED_LOCALLY, FIELD_ERRORS_HANDLED_LOCALLY } from './error-interceptor';

describe('errorInterceptor', () => {
  let http: HttpClient;
  const handled: { error: ApiError; context: ApiErrorContext }[] = [];

  beforeEach(() => {
    handled.length = 0;
    TestBed.configureTestingModule({
      providers: [
        provideHttpTesting(),
        signedInAsAlice().providers,
        {
          provide: ApiErrorHandler,
          useValue: {
            handle: (error: ApiError, context: ApiErrorContext) => handled.push({ error, context }),
          },
        },
      ],
    });
    http = TestBed.inject(HttpClient);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('own API', () => {
    it('when the backend answers with problem+json then an ApiError with its request id is thrown and handled', async () => {
      const response = firstValueFrom(http.post('/api/boards', {}));
      await settle();

      expectRequest('POST', '/api/boards').flush(
        aProblem({ code: 'FORBIDDEN', status: 403, requestId: 'req-403' }),
        problemResponse(403, 'Forbidden', 'req-403'),
      );

      const error = await response.catch((e: unknown) => e);
      expect(error, 'rejection').toBeInstanceOf(ApiError);
      expect((error as ApiError).requestId, 'request id').toBe('req-403');
      expect(
        handled.map((h) => h.context),
        'handler calls',
      ).toEqual([{ method: 'POST', fieldErrorsHandledLocally: false }]);
    });

    it('when the form handles violations itself then the handler is told so', async () => {
      const context = new HttpContext().set(FIELD_ERRORS_HANDLED_LOCALLY, true);
      const response = firstValueFrom(http.post('/api/boards', {}, { context }));
      await settle();

      expectRequest('POST', '/api/boards').flush(
        aProblem({ code: 'VALIDATION_FAILED', status: 400 }),
        problemResponse(400, 'Bad Request'),
      );

      await response.catch(() => undefined);
      expect(handled[0]?.context.fieldErrorsHandledLocally, 'flag passed to the handler').toBe(
        true,
      );
    });
  });

  describe('errors handled locally', () => {
    it('when the caller shows every error itself then the ApiError is thrown but the handler is not called', async () => {
      const response = firstValueFrom(
        http.post(
          '/api/shares/exchange',
          {},
          {
            context: new HttpContext().set(ERRORS_HANDLED_LOCALLY, true),
          },
        ),
      );
      await settle();

      expectRequest('POST', '/api/shares/exchange').flush(
        aProblem({ code: 'LIBRARY_SHARE_NOT_FOUND', status: 404 }),
        problemResponse(404, 'Not Found'),
      );

      expect(await response.catch((e: unknown) => e), 'rejection').toBeInstanceOf(ApiError);
      expect(handled, 'handler calls').toEqual([]);
    });
  });

  describe('other URLs', () => {
    it('when a URL outside /api fails then the error passes through untouched', async () => {
      const response = firstValueFrom(http.get('/config.json'));
      await settle();

      TestBed.inject(HttpTestingController)
        .expectOne('/config.json', 'config request')
        .flush('nope', { status: 404, statusText: 'Not Found' });

      const error = await response.catch((e: unknown) => e);
      expect(error, 'rejection of a foreign call').not.toBeInstanceOf(ApiError);
      expect(handled, 'handler calls').toEqual([]);
    });
  });
});
