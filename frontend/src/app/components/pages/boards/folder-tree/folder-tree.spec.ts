import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { all, buttonByLabel, buttonByText, textOf, typeInto } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { TEAM_FOLDER_ID, WORK_FOLDER_ID, aFolder } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { flushFolders } from '../testing/library';
import { BoardMover } from '../board-mover';
import { FolderTree } from './folder-tree';
import { aProblem } from '../../../../test/fixtures';

describe('FolderTree', () => {
  let fixture: ComponentFixture<FolderTree>;
  const work = aFolder();
  const team = aFolder({ id: TEAM_FOLDER_ID, name: 'Team', parentId: WORK_FOLDER_ID });

  async function render(folders = [work, team], active?: string): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(FolderTree, {
      bindings: [inputBinding('active', () => active)],
    });
    await settle();
    await flushFolders(folders);
    await fixture.whenStable();
  }

  const names = (): string[] => all(fixture, 'a').map((a) => a.textContent?.trim() ?? '');

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('rendering', () => {
    it('when there are folders then they nest and link to the mine view of the folder', async () => {
      await render();

      expect(names(), 'folders').toEqual(['Work', 'Team']);
      expect(all<HTMLAnchorElement>(fixture, 'a')[1].getAttribute('href'), 'link').toBe(
        `/boards?view=mine&folder=${TEAM_FOLDER_ID}`,
      );
    });

    it('when a folder is active then it is the current page', async () => {
      await render([work, team], TEAM_FOLDER_ID);

      const current = all(fixture, 'a[aria-current=page]').map((a) => a.textContent?.trim());
      expect(current, 'current').toEqual(['Team']);
    });

    it('when there are no folders then a hint is shown', async () => {
      await render([]);

      expect(textOf(fixture), 'hint').toContain('No folders yet.');
    });

    it('when the folders cannot be loaded then an alert offers Try again', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
      });
      fixture = TestBed.createComponent(FolderTree);
      await settle();
      expectRequest('GET', '/api/folders').flush(
        aProblem({ status: 500 }),
        problemResponse(500, 'Server Error'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('Folders could not be loaded.');
      buttonByText(fixture, 'Try again').click();
      await settle();
      await flushFolders([]);
    });

    it('when a folder with subfolders is collapsed then its children are hidden', async () => {
      await render();

      buttonByLabel(fixture, 'Collapse Work').click();
      await fixture.whenStable();

      expect(names(), 'folders').toEqual(['Work']);
    });
  });

  describe('create', () => {
    it('when New folder is used then the folder is created at the top level and the tree reloads', async () => {
      await render([]);

      buttonByLabel(fixture, 'New folder').click();
      await fixture.whenStable();
      typeInto(fixture, 'input', 'Plans');
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();
      const create = expectRequest('POST', '/api/folders', 'create folder');
      expect(create.request.body, 'request body').toEqual({ name: 'Plans' });
      create.flush(aFolder({ name: 'Plans' }), { status: 201, statusText: 'Created' });
      await settle();
      await flushFolders([aFolder({ name: 'Plans' })]);
      await fixture.whenStable();

      expect(names(), 'folders after create').toEqual(['Plans']);
      expect(all(fixture, 'input').length, 'form closed').toBe(0);
    });

    it('when New folder is cancelled then the form closes', async () => {
      await render([]);
      buttonByLabel(fixture, 'New folder').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(all(fixture, 'input').length, 'inputs').toBe(0);
    });
  });

  describe('folder menu', () => {
    async function choose(folder: string, entry: string): Promise<void> {
      buttonByLabel(fixture, `Actions of folder ${folder}`).click();
      await fixture.whenStable();
      buttonByText(fixture, entry).click();
      await fixture.whenStable();
    }

    it('when Rename is used then the folder is updated with its version and the tree reloads', async () => {
      await render([aFolder({ version: 3 })]);

      await choose('Work', 'Rename');
      typeInto(fixture, 'input', 'Jobs');
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();
      const update = expectRequest('PUT', `/api/folders/${WORK_FOLDER_ID}`, 'rename folder');
      expect(update.request.body, 'request body').toEqual({
        name: 'Jobs',
        parentId: null,
        version: 3,
      });
      update.flush(aFolder({ name: 'Jobs' }));
      await settle();
      await flushFolders([aFolder({ name: 'Jobs' })]);
      await fixture.whenStable();

      expect(names(), 'folders').toEqual(['Jobs']);
    });

    it('when New subfolder is used then the folder is created below it', async () => {
      await render([work]);

      await choose('Work', 'New subfolder');
      typeInto(fixture, 'input', 'Team');
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();
      const create = expectRequest('POST', '/api/folders', 'create subfolder');
      expect(create.request.body, 'request body').toEqual({
        name: 'Team',
        parentId: WORK_FOLDER_ID,
      });
      create.flush(team, { status: 201, statusText: 'Created' });
      await settle();
      await flushFolders([work, team]);
    });

    it('when Share… is used then the share dialog of the folder opens', async () => {
      await render([work]);

      buttonByLabel(fixture, 'Actions of folder Work').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Share…').click();
      await settle();
      expectRequest('GET', `/api/folders/${WORK_FOLDER_ID}/members`, 'members').flush({
        owner: { kind: 'USER', userId: 'id-alice', displayName: 'Alice Admin', username: 'alice' },
        items: [],
      });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'dialog').toContain('Share folder “Work”');
      buttonByLabel(fixture, 'Close').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'closed').not.toContain('Share folder');
    });

    it('when Move to trash is confirmed then the folder is deleted and the tree reloads', async () => {
      await render([work]);

      await choose('Work', 'Move to trash');
      buttonByText(fixture, 'Yes, move to trash').click();
      await settle();
      expectRequest('DELETE', `/api/folders/${WORK_FOLDER_ID}`, 'delete folder').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();
      await flushFolders([]);
      await fixture.whenStable();

      expect(textOf(fixture), 'tree').toContain('No folders yet.');
    });

    it('when Move to trash is asked and cancelled then nothing is sent', async () => {
      await render([work]);

      await choose('Work', 'Move to trash');
      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(all(fixture, '[role=group]').length, 'question').toBe(0);
    });

    it('when Move to… picks the top level then the folder gets no parent', async () => {
      await render([work, team]);

      await choose('Team', 'Move to…');
      buttonByText(fixture, 'My boards (top level)').click();
      await settle();
      const update = expectRequest('PUT', `/api/folders/${TEAM_FOLDER_ID}`, 'move folder');
      expect(update.request.body, 'request body').toEqual({
        name: 'Team',
        parentId: null,
        version: 0,
      });
      update.flush(aFolder({ id: TEAM_FOLDER_ID, name: 'Team' }));
      await settle();
      await flushFolders([work, team]);
    });

    it('when the move would make a cycle then the folder and its subfolders cannot be picked', async () => {
      await render([work, team]);

      await choose('Work', 'Move to…');

      const picker = all(fixture, 'drawboard-folder-picker button');
      const disabled = picker
        .filter((b) => (b as HTMLButtonElement).disabled)
        .map((b) => b.textContent?.trim());
      expect(disabled, 'disabled targets').toEqual(['My boards (top level)', 'Work', 'Team']);
    });
  });

  describe('drop target', () => {
    it('when a board is dropped on a folder then it moves there', async () => {
      await render([work]);
      const board = (await import('../../../../test/fixtures')).aBoard();
      TestBed.inject(BoardMover).dragged.set(board);
      const row = all(fixture, 'li > div')[0];
      const over = new Event('dragover', { cancelable: true });

      row.dispatchEvent(over);
      row.dispatchEvent(new Event('drop', { cancelable: true }));
      await settle();
      const move = expectRequest('PUT', `/api/boards/${board.id}/folder`, 'move board');
      expect(move.request.body, 'request body').toEqual({ folderId: WORK_FOLDER_ID, version: 0 });
      move.flush(board);
      await settle();

      expect(over.defaultPrevented, 'drop accepted').toBe(true);
    });

    it('when nothing is dragged then the folder does not accept a drop', async () => {
      await render([work]);
      const over = new Event('dragover', { cancelable: true });

      all(fixture, 'li > div')[0].dispatchEvent(over);

      expect(over.defaultPrevented, 'drop accepted').toBe(false);
    });
  });
});
