import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BoardRole } from '@apps/drawboard-api';

import { all, buttonByLabel, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../test/http-testing';
import { flushFolders } from '../testing/library';
import { aMemberList } from '../testing/share';
import { ShareKind } from '../share-target';
import { ShareDialog } from './share-dialog';

describe('ShareDialog', () => {
  let fixture: ComponentFixture<ShareDialog>;
  let closed: number;

  async function render(role: BoardRole, kind: ShareKind = 'board'): Promise<void> {
    closed = 0;
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(ShareDialog, {
      bindings: [
        inputBinding('kind', () => kind),
        inputBinding('resourceId', () => SPRINT_BOARD_ID),
        inputBinding('name', () => 'Sprint planning'),
        inputBinding('role', () => role),
        outputBinding('closed', () => closed++),
      ],
    });
    await settle();
    await flushFolders();
    expectRequest('GET', `/api/${kind}s/${SPRINT_BOARD_ID}/members`, 'members').flush(
      aMemberList(),
    );
    await settle();
    await fixture.whenStable();
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('as the owner', () => {
    it('when opened for a board then the heading names it and People and Links tabs exist', async () => {
      await render(BoardRole.OWNER);

      expect(textOf(fixture), 'heading').toContain('Share board “Sprint planning”');
      expect(
        all(fixture, '[role=tab]').map((t) => t.textContent?.trim()),
        'tabs',
      ).toEqual(['People', 'Links']);
      expect(all(fixture, '#share-search').length, 'people management').toBe(1);
    });

    it('when opened for a folder then the heading says folder and the folder routes are used', async () => {
      await render(BoardRole.OWNER, 'folder');

      expect(textOf(fixture), 'heading').toContain('Share folder “Sprint planning”');
    });

    it('when the Links tab is chosen then the link form is shown and the tab is selected', async () => {
      await render(BoardRole.OWNER);

      buttonByText(fixture, 'Links').click();
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/links`, 'links').flush({ items: [] });
      await settle();
      await fixture.whenStable();

      expect(all(fixture, 'form[aria-label="Create a link"]').length, 'link form').toBe(1);
      expect(all(fixture, '[role=tab]')[1].getAttribute('aria-selected'), 'selected tab').toBe(
        'true',
      );
    });
  });

  describe('as anyone else', () => {
    it.each([BoardRole.EDITOR, BoardRole.COMMENTER, BoardRole.VIEWER])(
      'when the role is %s then there are no tabs and the member list is read-only',
      async (role) => {
        await render(role);

        expect(all(fixture, '[role=tab]').length, 'tabs').toBe(0);
        expect(all(fixture, '#share-search').length, 'search').toBe(0);
        expect(textOf(fixture), 'hint').toContain('Only the owner can change who has access.');
      },
    );
  });

  describe('closing', () => {
    it('when Close is clicked then closed is emitted', async () => {
      await render(BoardRole.OWNER);

      buttonByLabel(fixture, 'Close').click();

      expect(closed, 'closed events').toBe(1);
    });
  });
});
