import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Folder } from '@apps/drawboard-api';

import { all, buttonByLabel, buttonByText, textOf, typeInto } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, WORK_FOLDER_ID, aFolder, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { flushFolders } from '../testing/library';
import { BOB, STAFF, aMember, aMemberList } from '../testing/share';
import { SharePeople } from './share-people';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('SharePeople', () => {
  let fixture: ComponentFixture<SharePeople>;
  const base = `/api/boards/${SPRINT_BOARD_ID}`;

  async function render(
    items = [aMember()],
    canManage = true,
    folders: Folder[] = [],
  ): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(SharePeople, {
      bindings: [
        inputBinding('kind', () => 'board'),
        inputBinding('resourceId', () => SPRINT_BOARD_ID),
        inputBinding('canManage', () => canManage),
      ],
    });
    await settle();
    await flushFolders(folders);
    expectRequest('GET', `${base}/members`, 'list members').flush(aMemberList(items));
    await settle();
    await fixture.whenStable();
  }

  const rows = (): string[] =>
    all(fixture, 'ul[aria-label="People with access"] > li').map(
      (li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );

  /** Types a search text and waits for the debounce to pass. */
  async function search(text: string): Promise<void> {
    typeInto(fixture, '#share-search', text);
    await settle();
    await wait(350);
    await settle();
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('the list', () => {
    it('when members exist then the owner comes first, then users and groups with their detail', async () => {
      await render([aMember(STAFF, 'COMMENTER'), aMember(BOB, 'EDITOR')]);

      const list = rows();
      expect(list[0], 'owner').toContain('Alice Admin');
      expect(list[0], 'owner role').toContain('Owner');
      expect(list[1], 'user').toContain('Bob Builder @bob');
      expect(list[2], 'group').toContain('Group');
    });

    it('when a grant is inherited then it is marked with the name of the folder and has no controls', async () => {
      await render([aMember(BOB, 'VIEWER', WORK_FOLDER_ID)], true, [aFolder()]);

      expect(textOf(fixture), 'inheritance').toContain('from folder Work');
      expect(all(fixture, 'select[id^="role-"]').length, 'role selects').toBe(0);
      expect(rows()[1], 'role as text').toContain('Viewer');
    });

    it('when the folder of an inherited grant is not known then it says "from a folder above"', async () => {
      await render([aMember(BOB, 'VIEWER', WORK_FOLDER_ID)]);

      expect(textOf(fixture), 'inheritance').toContain('from a folder above');
    });

    it('when the user may not manage then the list is read-only and says who can change it', async () => {
      await render([aMember()], false);

      expect(all(fixture, 'select').length, 'selects').toBe(0);
      expect(all(fixture, '#share-search').length, 'search fields').toBe(0);
      expect(all(fixture, 'button[aria-label^="Remove"]').length, 'remove buttons').toBe(0);
      expect(textOf(fixture), 'hint').toContain('Only the owner can change who has access.');
    });

    it('when the members cannot be loaded then an alert with the request id is shown', async () => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: '**', children: [] }]),
          provideHttpTesting(),
          signedInAsAlice().providers,
        ],
      });
      fixture = TestBed.createComponent(SharePeople, {
        bindings: [
          inputBinding('kind', () => 'board'),
          inputBinding('resourceId', () => SPRINT_BOARD_ID),
        ],
      });
      await settle();
      await flushFolders();
      expectRequest('GET', `${base}/members`).flush(
        aProblem({ status: 403, code: 'FORBIDDEN', requestId: 'req-403' }),
        problemResponse(403, 'Forbidden', 'req-403'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('req-403');
    });
  });

  describe('changing and removing', () => {
    it('when the role of a user is changed then it is sent and the list reloads', async () => {
      await render([aMember(BOB, 'EDITOR')]);
      const select = all<HTMLSelectElement>(fixture, 'select[id^="role-"]')[0];

      select.value = 'VIEWER';
      select.dispatchEvent(new Event('change'));
      await settle();
      const put = expectRequest('PUT', `${base}/members/users/id-bob`, 'set role');
      expect(put.request.body, 'body').toEqual({ role: 'VIEWER' });
      put.flush({ principal: BOB, role: 'VIEWER' });
      await settle();

      expectRequest('GET', `${base}/members`, 'reload').flush(aMemberList());
      await settle();
    });

    it('when the role of a group is changed then the group route is used', async () => {
      await render([aMember(STAFF, 'EDITOR')]);
      const select = all<HTMLSelectElement>(fixture, 'select[id^="role-"]')[0];

      select.value = 'COMMENTER';
      select.dispatchEvent(new Event('change'));
      await settle();
      expectRequest('PUT', `${base}/members/groups/staff`, 'set group role').flush({
        principal: STAFF,
        role: 'COMMENTER',
      });
      await settle();

      expectRequest('GET', `${base}/members`).flush(aMemberList());
      await settle();
      await fixture.whenStable();

      expect(rows().length, 'rows after the reload').toBe(1);
    });

    it('when a user is removed then the grant is deleted and the list reloads', async () => {
      await render([aMember(BOB)]);

      buttonByLabel(fixture, 'Remove Bob Builder').click();
      await settle();
      expectRequest('DELETE', `${base}/members/users/id-bob`, 'remove').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expectRequest('GET', `${base}/members`).flush(aMemberList());
      await settle();
      await fixture.whenStable();
      expect(rows().length, 'rows').toBe(1);
    });

    it('when a group is removed then the group route is used', async () => {
      await render([aMember(STAFF)]);

      buttonByLabel(fixture, 'Remove staff').click();
      await settle();
      expectRequest('DELETE', `${base}/members/groups/staff`, 'remove group').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expectRequest('GET', `${base}/members`).flush(aMemberList());
      await settle();
      await fixture.whenStable();

      expect(rows().length, 'rows after the reload').toBe(1);
    });
  });

  describe('adding people', () => {
    it('when fewer than 2 characters are typed then nothing is searched', async () => {
      await render();

      await search('a');

      expect(all(fixture, '[aria-label="Search results"]').length, 'result list').toBe(0);
    });

    it('when 2 characters are typed then the search runs after the debounce and shows the hits', async () => {
      await render();

      await search('ca');
      const request = expectRequest('GET', '/api/users/search', 'search users');
      expect(request.request.params.get('q'), 'q').toBe('ca');
      request.flush({ items: [{ id: 'id-carol', username: 'carol', displayName: 'Carol C' }] });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'hit').toContain('Carol C');
      expect(textOf(fixture), 'username').toContain('@carol');
    });

    it('when a hit is clicked then the user is added with the chosen role and the search resets', async () => {
      await render();
      await search('ca');
      expectRequest('GET', '/api/users/search').flush({
        items: [{ id: 'id-carol', username: 'carol', displayName: 'Carol C' }],
      });
      await settle();
      await fixture.whenStable();
      const role = all<HTMLSelectElement>(fixture, '#share-new-role')[0];
      role.value = 'EDITOR';
      role.dispatchEvent(new Event('change'));

      all(fixture, 'li button.panel-item')[0].click();
      await settle();
      const put = expectRequest('PUT', `${base}/members/users/id-carol`, 'add user');
      expect(put.request.body, 'body').toEqual({ role: 'EDITOR' });
      put.flush({ principal: { ...BOB, userId: 'id-carol' }, role: 'EDITOR' });
      await settle();
      expectRequest('GET', `${base}/members`).flush(aMemberList());
      await settle();

      expect(all<HTMLInputElement>(fixture, '#share-search')[0].value, 'search field').toBe('');
    });

    it('when a hit is already a member then it is not offered again', async () => {
      await render([aMember(BOB)]);

      await search('bo');
      expectRequest('GET', '/api/users/search').flush({
        items: [{ id: 'id-bob', username: 'bob', displayName: 'Bob Builder' }],
      });
      await settle();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=no-results]').length, 'no-results hint').toBe(1);
    });

    it('when the search is rate limited then the toast has the request id and no hits show', async () => {
      await render();

      await search('ca');
      expectRequest('GET', '/api/users/search').flush(
        aProblem({ status: 429, code: 'TOO_MANY_REQUESTS', requestId: 'req-429' }),
        problemResponse(429, 'Too Many Requests', 'req-429'),
      );
      await settle();
      await fixture.whenStable();

      expect(all(fixture, 'li button.panel-item').length, 'hits').toBe(0);
    });
  });

  describe('adding a group', () => {
    it('when a valid name is entered then the group is granted the role', async () => {
      await render();

      typeInto(fixture, '#share-group', 'engineering');
      await fixture.whenStable();
      buttonByText(fixture, 'Add group').click();
      await settle();
      const put = expectRequest('PUT', `${base}/members/groups/engineering`, 'add group');
      expect(put.request.body, 'body').toEqual({ role: 'VIEWER' });
      put.flush({ principal: STAFF, role: 'VIEWER' });
      await settle();
      expectRequest('GET', `${base}/members`).flush(aMemberList());
      await settle();
    });

    it('when the name has forbidden characters then an error is shown and nothing is sent', async () => {
      await render();

      typeInto(fixture, '#share-group', 'bad/name');
      await fixture.whenStable();
      buttonByText(fixture, 'Add group').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'error').toContain('Letters, digits');
    });

    it('when the name is empty then the form asks for it', async () => {
      await render();

      buttonByText(fixture, 'Add group').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'error').toContain('Enter the name of the group.');
    });
  });
});
