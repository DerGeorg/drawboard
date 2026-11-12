import { HttpContext } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { aBoard, aProblem } from '../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../test/http-testing';
import { RecordedSpans, recordSpans } from '../../../test/tracing';
import { ApiError } from '../../../util/api-error';
import { BoardActions } from './board-actions';

describe('BoardActions', () => {
  let actions: BoardActions;
  let toasts: Toasts;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    actions = TestBed.inject(BoardActions);
    toasts = TestBed.inject(Toasts);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('create', () => {
    it('when the backend creates the board then the new board is returned', async () => {
      const result = actions.create('Retro');
      await settle();

      const request = expectRequest('POST', '/api/boards', 'create board');
      expect(request.request.body, 'request body').toEqual({ title: 'Retro' });
      request.flush(aBoard({ title: 'Retro' }));

      expect((await result).title, 'created board title').toBe('Retro');
    });

    it('when the backend refuses then the ApiError is thrown with the request id', async () => {
      const result = actions.create('Retro');
      await settle();

      expectRequest('POST', '/api/boards').flush(
        aProblem({ code: 'INTERNAL_ERROR', status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );

      const error = await result.catch((e: unknown) => e);
      expect(error, 'rejection').toBeInstanceOf(ApiError);
      expect((error as ApiError).requestId, 'request id').toBe('req-500');
    });

    it('when the caller passes a context then the interceptors receive it', async () => {
      const context = new HttpContext();
      const result = actions.create('Retro', context);
      await settle();

      const request = expectRequest('POST', '/api/boards');
      request.flush(aBoard());
      await result;

      expect(request.request.context, 'context of the request').toBeDefined();
    });
  });

  describe('rename', () => {
    it('when the title changes then the loaded version is sent', async () => {
      const board = aBoard({ version: 3 });
      const result = actions.rename(board, 'New title');
      await settle();

      const request = expectRequest('PUT', `/api/boards/${board.id}`, 'rename board');
      expect(request.request.body, 'request body').toEqual({ title: 'New title', version: 3 });
      request.flush({ ...board, title: 'New title', version: 4 });

      expect((await result).version, 'new version').toBe(4);
    });

    it('when the version is stale then a conflict ApiError is thrown and a toast is shown', async () => {
      const board = aBoard();
      const result = actions.rename(board, 'Mine');
      await settle();

      expectRequest('PUT', `/api/boards/${board.id}`).flush(
        aProblem({ code: 'CONFLICT', status: 409, requestId: 'req-409' }),
        problemResponse(409, 'Conflict', 'req-409'),
      );

      const error = (await result.catch((e: unknown) => e)) as ApiError;
      expect(error.status, 'status').toBe(409);
      expect(
        toasts.toasts().map((t) => t.requestId),
        'request ids of the toasts',
      ).toEqual(['req-409']);
    });
  });

  describe('delete', () => {
    it('when the backend deletes the board then true is returned with a success toast', async () => {
      const board = aBoard();
      const result = actions.delete(board);
      await settle();

      expectRequest('DELETE', `/api/boards/${board.id}`, 'delete board').flush(null, {
        status: 204,
        statusText: 'No Content',
      });

      expect(await result, 'result').toBe(true);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['"Sprint planning" was moved to the trash.']);
    });

    it('when the backend refuses then false is returned and the error toast has the request id', async () => {
      const board = aBoard();
      const result = actions.delete(board);
      await settle();

      expectRequest('DELETE', `/api/boards/${board.id}`).flush(
        aProblem({ code: 'LIBRARY_BOARD_ACCESS_DENIED', status: 403, requestId: 'req-403' }),
        problemResponse(403, 'Forbidden', 'req-403'),
      );

      expect(await result, 'result').toBe(false);
      expect(
        toasts.toasts().map((t) => t.requestId),
        'request ids of the toasts',
      ).toEqual(['req-403']);
    });
  });

  describe('tracing', () => {
    let spans: RecordedSpans;

    beforeEach(() => {
      spans = recordSpans();
    });

    afterEach(() => spans.stop());

    it('when a board is renamed then the span carries the board id and no title', async () => {
      const board = aBoard();
      const result = actions.rename(board, 'Secret title');
      await settle();
      expectRequest('PUT', `/api/boards/${board.id}`).flush(board);
      await result;

      expect(spans.byName('BoardActions.rename').attributes, 'span attributes').toEqual({
        'board.id': board.id,
      });
    });
  });

  describe('create in a folder', () => {
    it('when a folder id is given then the board is created in it', async () => {
      const result = actions.create('Retro', undefined, 'folder-1');
      await settle();

      const request = expectRequest('POST', '/api/boards', 'create board');
      expect(request.request.body, 'request body').toEqual({
        title: 'Retro',
        folderId: 'folder-1',
      });
      request.flush(aBoard());
      await result;
    });
  });

  describe('move', () => {
    it('when the backend moves the board then it is returned; the version is sent for locking', async () => {
      const result = actions.move(aBoard({ version: 4 }), 'folder-1');
      await settle();

      const request = expectRequest('PUT', `/api/boards/${aBoard().id}/folder`, 'move board');
      expect(request.request.body, 'request body').toEqual({ folderId: 'folder-1', version: 4 });
      request.flush(aBoard({ folderId: 'folder-1', version: 5 }));

      expect((await result)?.folderId, 'moved board').toBe('folder-1');
    });

    it('when the version is outdated (409) then undefined is returned and the error is toasted', async () => {
      const result = actions.move(aBoard(), null);
      await settle();

      expectRequest('PUT', `/api/boards/${aBoard().id}/folder`).flush(
        aProblem({ code: 'CONFLICT', status: 409, requestId: 'req-409' }),
        problemResponse(409, 'Conflict', 'req-409'),
      );

      expect(await result, 'result').toBeUndefined();
      expect(
        toasts.toasts().map((t) => t.requestId),
        'request ids',
      ).toEqual(['req-409']);
    });
  });

  describe('restore and purge', () => {
    it('when a board is restored then true is returned with a success toast', async () => {
      const result = actions.restore(aBoard());
      await settle();

      expectRequest('POST', `/api/trash/boards/${aBoard().id}/restore`, 'restore').flush(aBoard());

      expect(await result, 'result').toBe(true);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['"Sprint planning" was restored.']);
    });

    it('when a board is purged then true is returned with a success toast', async () => {
      const result = actions.purge(aBoard());
      await settle();

      expectRequest('DELETE', `/api/trash/boards/${aBoard().id}`, 'purge').flush(null, {
        status: 204,
        statusText: 'No Content',
      });

      expect(await result, 'result').toBe(true);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['"Sprint planning" was deleted for good.']);
    });

    it('when the purge is refused then false is returned', async () => {
      const result = actions.purge(aBoard());
      await settle();

      expectRequest('DELETE', `/api/trash/boards/${aBoard().id}`).flush(
        aProblem({ code: 'LIBRARY_BOARD_NOT_FOUND', status: 404 }),
        problemResponse(404, 'Not Found'),
      );

      expect(await result, 'result').toBe(false);
    });
  });
});
