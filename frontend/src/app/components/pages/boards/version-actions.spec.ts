import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BoardVersion } from '@apps/drawboard-api';

import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { SPRINT_BOARD_ID, aProblem } from '../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../test/http-testing';
import { VersionActions } from './version-actions';

const version: BoardVersion = {
  id: 'v1',
  upToSeq: 10,
  createdAt: '2026-11-09T10:00:00Z',
  size: 2048,
};

describe('VersionActions', () => {
  let actions: VersionActions;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    actions = TestBed.inject(VersionActions);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('restore', () => {
    it('when the backend restores the version then true is returned', async () => {
      const result = actions.restore(SPRINT_BOARD_ID, version);
      await settle();

      expectRequest('POST', `/api/boards/${SPRINT_BOARD_ID}/versions/v1/restore`, 'restore').flush(
        null,
        { status: 204, statusText: 'No Content' },
      );

      expect(await result, 'result').toBe(true);
    });

    it('when the backend refuses then false is returned and the error is toasted', async () => {
      const result = actions.restore(SPRINT_BOARD_ID, version);
      await settle();

      expectRequest('POST', `/api/boards/${SPRINT_BOARD_ID}/versions/v1/restore`).flush(
        aProblem({ code: 'COLLAB_VERSION_NOT_FOUND', status: 404, requestId: 'req-404' }),
        problemResponse(404, 'Not Found', 'req-404'),
      );

      expect(await result, 'result').toBe(false);
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.requestId),
        'request ids',
      ).toEqual(['req-404']);
    });
  });
});
