import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiError } from '../../../util/api-error';
import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { aProblem } from '../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../test/http-testing';
import { GifSearch, gifProblemOf, problemText, waitText } from './gif-search';

function apiError(status: number, code: string, retryAfter?: string): ApiError {
  const headers = new HttpHeaders(retryAfter ? { 'Retry-After': retryAfter } : {});
  return new ApiError(
    aProblem({ status, code }),
    undefined,
    new HttpErrorResponse({ status, headers }),
  );
}

describe('GIF search', () => {
  describe('GifSearch', () => {
    let search: GifSearch;

    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [provideHttpTesting(), signedInAsAlice().providers],
      });
      search = TestBed.inject(GifSearch);
    });

    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('when a search is made then the text goes in a POST body and never in the URL (G8)', async () => {
      const result = search.search('happy cat', 2);
      await settle();

      const request = expectRequest('POST', '/api/gifs/search', 'search');
      expect(request.request.body, 'body').toEqual({ q: 'happy cat', page: 2 });
      expect(request.request.urlWithParams, 'url').toBe('/api/gifs/search');
      request.flush({ items: [{ id: 'abc', title: 'cat', width: 4, height: 3 }], hasMore: true });

      expect((await result).items[0]?.id, 'id').toBe('abc');
    });

    it('when trending is asked then it is a plain GET without any text', async () => {
      const result = search.trending();
      await settle();

      const request = expectRequest('GET', '/api/gifs/trending', 'trending');
      request.flush({ items: [], hasMore: false });

      expect((await result).items, 'items').toEqual([]);
    });

    it('when the search fails then the error is thrown without a toast', async () => {
      const toasts = TestBed.inject(Toasts);
      const result = search.search('cat', 0).catch((e: unknown) => e);
      await settle();

      expectRequest('POST', '/api/gifs/search').flush(
        aProblem({ status: 429, code: 'TOO_MANY_REQUESTS' }),
        { ...problemResponse(429, 'Too Many Requests'), headers: { 'Retry-After': '20' } },
      );

      const error = await result;
      expect(error, 'error type').toBeInstanceOf(ApiError);
      expect(gifProblemOf(error), 'problem').toEqual({
        kind: 'rate',
        scope: 'user',
        waitSeconds: 20,
      });
      expect(toasts.toasts(), 'no toast').toEqual([]);
    });

    it('when the instance answers GIFS_DISABLED then the search is marked disabled', async () => {
      const result = search.trending().catch((e: unknown) => e);
      await settle();

      expectRequest('GET', '/api/gifs/trending').flush(
        aProblem({ status: 404, code: 'GIFS_DISABLED' }),
        problemResponse(404, 'Not Found'),
      );
      await result;

      expect(search.disabled(), 'disabled').toBe(true);
      expect(TestBed.inject(Toasts).toasts(), 'no toast').toEqual([]);
    });
  });

  describe('gifProblemOf', () => {
    it('when GIFS_DISABLED comes then the picker is told to go away', () => {
      expect(gifProblemOf(apiError(404, 'GIFS_DISABLED')), 'disabled').toEqual({
        kind: 'disabled',
      });
    });

    it('when the user limit or the instance budget is hit then both are rate problems with the wait', () => {
      expect(gifProblemOf(apiError(429, 'TOO_MANY_REQUESTS', '30')), 'user limit').toEqual({
        kind: 'rate',
        scope: 'user',
        waitSeconds: 30,
      });
      expect(
        gifProblemOf(apiError(429, 'GIFS_BUDGET_EXHAUSTED', '1200')),
        'instance budget',
      ).toEqual({
        kind: 'rate',
        scope: 'instance',
        waitSeconds: 1200,
      });
      expect(gifProblemOf(apiError(429, 'TOO_MANY_REQUESTS')), 'no header').toEqual({
        kind: 'rate',
        scope: 'user',
        waitSeconds: undefined,
      });
    });

    it('when GIPHY is down or the error is something else then the problem says so', () => {
      expect(gifProblemOf(apiError(503, 'GIFS_UNAVAILABLE')), '503').toEqual({
        kind: 'unavailable',
      });
      expect(gifProblemOf(apiError(500, 'INTERNAL_ERROR')), '500').toEqual({ kind: 'other' });
      expect(gifProblemOf(new Error('x')), 'not an API error').toEqual({ kind: 'other' });
    });
  });

  describe('texts', () => {
    it('when the wait is given then it is words', () => {
      expect(waitText(1), 'one second').toBe('1 second');
      expect(waitText(20), 'seconds').toBe('20 seconds');
      expect(waitText(61), 'minutes').toBe('2 minutes');
      expect(waitText(undefined), 'unknown wait').toBe('a little while');
    });

    it('when each problem is shown then the text names what to do and quotes the wait', () => {
      expect(
        problemText({ kind: 'rate', scope: 'user', waitSeconds: 20 }),
        'user limit text',
      ).toContain('20 seconds');
      expect(
        problemText({ kind: 'rate', scope: 'instance', waitSeconds: 600 }),
        'instance text',
      ).toContain('instance');
      expect(problemText({ kind: 'unavailable' }), 'unavailable text').toContain('GIPHY');
    });
  });
});
