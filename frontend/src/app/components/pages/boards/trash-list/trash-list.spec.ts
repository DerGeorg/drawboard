import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { RETRO_BOARD_ID, aBoard, aFolder, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { flushFolders } from '../testing/library';
import { TrashList } from './trash-list';

describe('TrashList', () => {
  let fixture: ComponentFixture<TrashList>;
  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
  const oldBoard = aBoard({ title: 'Old board', deletedAt: daysAgo(10) });
  const newFolder = aFolder({ name: 'Gone folder', deletedAt: daysAgo(1) });

  async function render(boards = [oldBoard], folders = [newFolder]): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(TrashList);
    await settle();
    await flushFolders();
    expectRequest('GET', '/api/trash', 'list trash').flush({ boards, folders });
    await settle();
    await fixture.whenStable();
  }

  const titles = (): string[] =>
    all(fixture, 'li p.font-medium').map((p) => p.textContent?.trim() ?? '');

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('rendering', () => {
    it('when boards and folders are in the trash then the most recently deleted comes first', async () => {
      await render();

      expect(titles(), 'entries').toEqual(['Gone folder', 'Old board']);
      expect(textOf(fixture), 'kind').toContain('Folder · deleted');
    });

    it('when an entry was deleted 10 days ago then 20 days are left', async () => {
      await render();

      const left = all(fixture, '[data-testid=days-left]').map((e) => e.textContent?.trim());
      expect(left, 'days left').toEqual(['29 days left', '20 days left']);
    });

    it('when the trash is empty then the empty state is shown', async () => {
      await render([], []);

      expect(textOf(fixture), 'empty state').toContain('The trash is empty.');
    });

    it('when the trash cannot be loaded then an alert with the request id is shown', async () => {
      TestBed.configureTestingModule({
        providers: [provideHttpTesting(), signedInAsAlice().providers],
      });
      fixture = TestBed.createComponent(TrashList);
      await settle();
      await flushFolders();
      expectRequest('GET', '/api/trash').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('req-500');
      buttonByText(fixture, 'Try again').click();
      await settle();
      expectRequest('GET', '/api/trash').flush({ boards: [], folders: [] });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'empty state after retry').toContain('The trash is empty.');
    });
  });

  describe('restore', () => {
    it('when a board is restored then the trash reloads', async () => {
      await render([aBoard({ id: RETRO_BOARD_ID, title: 'Old board', deletedAt: daysAgo(1) })], []);

      buttonByText(fixture, 'Restore').click();
      await settle();
      expectRequest('POST', `/api/trash/boards/${RETRO_BOARD_ID}/restore`, 'restore board').flush(
        aBoard(),
      );
      await settle();
      expectRequest('GET', '/api/trash', 'reload trash').flush({ boards: [], folders: [] });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'empty state').toContain('The trash is empty.');
    });

    it('when a folder is restored then the trash and the folder tree reload', async () => {
      await render([], [newFolder]);

      buttonByText(fixture, 'Restore').click();
      await settle();
      expectRequest('POST', `/api/trash/folders/${newFolder.id}/restore`, 'restore folder').flush(
        aFolder(),
      );
      await settle();
      expectRequest('GET', '/api/trash').flush({ boards: [], folders: [] });
      await flushFolders([aFolder()]);
      await fixture.whenStable();

      expect(textOf(fixture), 'empty state').toContain('The trash is empty.');
    });
  });

  describe('delete forever', () => {
    it('when Delete forever is clicked then a confirmation is asked first and nothing is sent', async () => {
      await render([oldBoard], []);

      buttonByText(fixture, 'Delete forever').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'question').toContain('This cannot be undone.');
    });

    it('when the confirmation is cancelled then the entry stays', async () => {
      await render([oldBoard], []);
      buttonByText(fixture, 'Delete forever').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(titles(), 'entries').toEqual(['Old board']);
      expect(all(fixture, '[role=group]').length, 'question').toBe(0);
    });

    it('when the confirmation is accepted then the board is purged and the trash reloads', async () => {
      await render([oldBoard], []);
      buttonByText(fixture, 'Delete forever').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Yes, delete forever').click();
      await settle();
      expectRequest('DELETE', `/api/trash/boards/${oldBoard.id}`, 'purge board').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();
      expectRequest('GET', '/api/trash').flush({ boards: [], folders: [] });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'empty state').toContain('The trash is empty.');
    });

    it('when a folder is purged then the DELETE goes to the folder trash route', async () => {
      await render([], [newFolder]);
      buttonByText(fixture, 'Delete forever').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Yes, delete forever').click();
      await settle();
      expectRequest('DELETE', `/api/trash/folders/${newFolder.id}`, 'purge folder').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();
      expectRequest('GET', '/api/trash').flush({ boards: [], folders: [] });
      await flushFolders([]);
      await fixture.whenStable();

      expect(textOf(fixture), 'empty state').toContain('The trash is empty.');
    });
  });
});
