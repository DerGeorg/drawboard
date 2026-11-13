import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { signedInAsAlice } from '../../../test/fake-auth';
import { RETRO_BOARD_ID, SPRINT_BOARD_ID, aBoard } from '../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../test/http-testing';
import { TemplateOwners } from './template-owners';

describe('TemplateOwners', () => {
  let owners: TemplateOwners;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    owners = TestBed.inject(TemplateOwners);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('name', () => {
    it('when the board belongs to the signed-in user then the name is You without any request', async () => {
      const mine = aBoard({ ownerId: 'id-alice' });

      await owners.resolve([mine]);

      expect(owners.name(mine), 'name').toBe('You');
    });

    it('when the owner is someone else then the display name comes from the member list, asked once per owner', async () => {
      const first = aBoard({ id: SPRINT_BOARD_ID, ownerId: 'id-bob' });
      const second = aBoard({ id: RETRO_BOARD_ID, ownerId: 'id-bob' });

      const done = owners.resolve([first, second]);
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush({
        owner: { kind: 'USER', userId: 'id-bob', displayName: 'Bob Builder', username: 'bob' },
        items: [],
      });
      await done;

      expect(owners.name(first), 'first board').toBe('Bob Builder');
      expect(owners.name(second), 'second board').toBe('Bob Builder');
    });

    it('when the name is not known yet then there is none', () => {
      expect(owners.name(aBoard({ ownerId: 'id-carol' })), 'name').toBeUndefined();
    });

    it('when the lookup fails then there is no name, no toast and no second try for that owner', async () => {
      const board = aBoard({ ownerId: 'id-bob' });

      const done = owners.resolve([board]);
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`).flush(
        { code: 'LIBRARY_BOARD_ACCESS_DENIED', status: 403 },
        { status: 403, statusText: 'Forbidden' },
      );
      await done;
      await owners.resolve([board]);

      expect(owners.name(board), 'name').toBeUndefined();
    });
  });
});
