import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { aProblem } from '../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../test/http-testing';
import { ShareActions } from './share-actions';
import { aShareLink } from './testing/share';

const NO_CONTENT = { status: 204, statusText: 'No Content' };

describe('ShareActions', () => {
  let actions: ShareActions;
  let toasts: Toasts;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    actions = TestBed.inject(ShareActions);
    toasts = TestBed.inject(Toasts);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('members of a folder', () => {
    it('when a user role is set on a folder then the folder route is used', async () => {
      const result = actions.setUserRole('folder', 'f1', 'u1', 'EDITOR');
      await settle();
      const put = expectRequest('PUT', '/api/folders/f1/members/users/u1', 'set user role');
      expect(put.request.body, 'body').toEqual({ role: 'EDITOR' });
      put.flush({});

      expect(await result, 'result').toBe(true);
    });

    it('when a group role is set on a folder then the folder group route is used', async () => {
      const result = actions.setGroupRole('folder', 'f1', 'staff', 'VIEWER');
      await settle();
      expectRequest('PUT', '/api/folders/f1/members/groups/staff').flush({});

      expect(await result, 'result').toBe(true);
    });

    it('when a user and a group are removed from a folder then both DELETE routes are used', async () => {
      const user = actions.removeUser('folder', 'f1', 'u1');
      await settle();
      expectRequest('DELETE', '/api/folders/f1/members/users/u1').flush(null, NO_CONTENT);
      const group = actions.removeGroup('folder', 'f1', 'staff');
      await settle();
      expectRequest('DELETE', '/api/folders/f1/members/groups/staff').flush(null, NO_CONTENT);

      expect([await user, await group], 'results').toEqual([true, true]);
    });
  });

  describe('members of a board', () => {
    it('when a group is granted and removed on a board then the board group routes are used', async () => {
      const set = actions.setGroupRole('board', 'b1', 'staff', 'COMMENTER');
      await settle();
      expectRequest('PUT', '/api/boards/b1/members/groups/staff').flush({});
      const remove = actions.removeGroup('board', 'b1', 'staff');
      await settle();
      expectRequest('DELETE', '/api/boards/b1/members/groups/staff').flush(null, NO_CONTENT);

      expect([await set, await remove], 'results').toEqual([true, true]);
    });

    it('when the backend refuses then false is returned and the error is toasted with the request id', async () => {
      const result = actions.removeUser('board', 'b1', 'u1');
      await settle();
      expectRequest('DELETE', '/api/boards/b1/members/users/u1').flush(
        aProblem({ status: 403, code: 'FORBIDDEN', requestId: 'req-403' }),
        problemResponse(403, 'Forbidden', 'req-403'),
      );

      expect(await result, 'result').toBe(false);
      expect(
        toasts.toasts().map((t) => t.requestId),
        'request ids',
      ).toEqual(['req-403']);
    });
  });

  describe('links', () => {
    it('when a link is created for a folder then the folder route is used and the URL is returned', async () => {
      const result = actions.createLink('folder', 'f1', { audience: 'SIGNED_IN', role: 'VIEWER' });
      await settle();
      expectRequest('POST', '/api/folders/f1/links', 'create folder link').flush(
        { link: aShareLink(), url: 'https://x.test/s#abc' },
        { status: 201, statusText: 'Created' },
      );

      expect((await result).url, 'url').toBe('https://x.test/s#abc');
    });

    it('when a link is revoked then a success toast is shown', async () => {
      const result = actions.revokeLink('link-1');
      await settle();
      expectRequest('DELETE', '/api/links/link-1', 'revoke').flush(null, NO_CONTENT);

      expect(await result, 'result').toBe(true);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['The link was revoked.']);
    });
  });
});
