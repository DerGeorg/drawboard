import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

import { aProblem } from '../test/fixtures';
import { ApiError, CLIENT_ERROR_CODES, toApiError } from './api-error';

describe('api-error', () => {
  describe('toApiError', () => {
    it('when the body is problem+json then code, violations and request id come from it', () => {
      const violations = [{ field: 'title', code: 'Pattern', message: 'must match' }];
      const error = toApiError(
        new HttpErrorResponse({
          status: 400,
          error: aProblem({
            code: 'VALIDATION_FAILED',
            status: 400,
            violations,
            requestId: 'from-body',
          }),
          headers: new HttpHeaders({ 'X-Request-Id': 'from-header' }),
        }),
      );

      expect(error, 'error type').toBeInstanceOf(ApiError);
      expect(error.code, 'code').toBe('VALIDATION_FAILED');
      expect(error.violations, 'violations').toEqual(violations);
      expect(error.requestId, 'request id of the body wins').toBe('from-body');
    });

    it('when the problem arrived as text then it is parsed', () => {
      const error = toApiError(
        new HttpErrorResponse({
          status: 409,
          error: JSON.stringify(aProblem({ code: 'CONFLICT', status: 409 })),
        }),
      );

      expect(error.code, 'code parsed from text').toBe('CONFLICT');
      expect(error.message, 'message').toBe('409 CONFLICT: Internal Server Error');
    });

    it('when a proxy answers with HTML then the status and the header request id are kept', () => {
      const error = toApiError(
        new HttpErrorResponse({
          status: 502,
          statusText: 'Bad Gateway',
          error: '<html>502</html>',
          headers: new HttpHeaders({ 'X-Request-Id': 'from-header' }),
        }),
      );

      expect(error.code, 'code').toBe(CLIENT_ERROR_CODES.unexpectedResponse);
      expect(error.status, 'status').toBe(502);
      expect(error.problem.title, 'title').toBe('Bad Gateway');
      expect(error.requestId, 'request id from the header').toBe('from-header');
    });

    it('when the network failed then it is a network error without request id', () => {
      const error = toApiError(
        new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }),
      );

      expect(error.code, 'code').toBe(CLIENT_ERROR_CODES.network);
      expect(error.requestId, 'request id').toBeUndefined();
      expect(error.violations, 'violations').toEqual([]);
    });
  });
});
