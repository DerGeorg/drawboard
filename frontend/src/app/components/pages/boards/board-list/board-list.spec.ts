import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardPage, BoardRole, Folder } from '@apps/drawboard-api';

import { all, buttonByLabel, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import {
  RETRO_BOARD_ID,
  TEAM_FOLDER_ID,
  WORK_FOLDER_ID,
  aBoard,
  aBoardPage,
  aFolder,
  aProblem,
} from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { BoardMover } from '../board-mover';
import { flushFolders } from '../testing/library';
import { BoardList } from './board-list';

describe('BoardList', () => {
  let fixture: ComponentFixture<BoardList>;
  const page = signal<unknown>(undefined);
  const view = signal<unknown>(undefined);
  const folder = signal<unknown>(undefined);

  const work = aFolder();
  const team = aFolder({ id: TEAM_FOLDER_ID, name: 'Team', parentId: WORK_FOLDER_ID });

  /** Renders the page; the sidebar tree asks for the own folders (answered with `folders`). */
  async function render(folders: Folder[] = []): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(BoardList, {
      bindings: [
        inputBinding('page', page),
        inputBinding('view', view),
        inputBinding('folder', folder),
      ],
    });
    await settle();
    await flushFolders(folders);
  }

  /** Answers the pending list request and waits until the view shows it. */
  async function respondWith(boardPage: BoardPage = aBoardPage()): Promise<void> {
    expectRequest('GET', '/api/boards', 'list boards').flush(boardPage);
    await settle();
    await fixture.whenStable();
  }

  beforeEach(() => {
    page.set(undefined);
    view.set(undefined);
    folder.set(undefined);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('loading', () => {
    it('when the request is pending then a loading text is shown', async () => {
      await render();

      // NOT whenStable(): a loading resource is a pending task, whenStable() would wait for it.
      expect(textOf(fixture), 'text while loading').toContain('Loading your boards');
      await respondWith();
    });

    it('when no page is in the URL then the first page with 12 boards is requested', async () => {
      await render();

      const request = expectRequest('GET', '/api/boards', 'list boards');
      expect(request.request.params.get('page'), 'page parameter').toBe('0');
      expect(request.request.params.get('size'), 'size parameter').toBe('12');
      request.flush(aBoardPage());
    });

    it('when ?page=2 is in the URL then the second page is requested', async () => {
      page.set('2');
      await render();

      const request = expectRequest('GET', '/api/boards', 'list boards');
      expect(request.request.params.get('page'), 'zero-based page parameter').toBe('1');
      request.flush(aBoardPage([], 1, 2));
    });

    it('when the backend returns two boards then one card per board is shown', async () => {
      await render();
      await respondWith(
        aBoardPage([
          aBoard(),
          aBoard({ id: RETRO_BOARD_ID, title: 'Retro', role: BoardRole.VIEWER }),
        ]),
      );

      expect(all(fixture, 'article').length, 'number of cards').toBe(2);
      expect(textOf(fixture), 'titles').toContain('Retro');
      expect(textOf(fixture), 'role of the second board').toContain('Viewer');
    });

    it('when the backend returns no boards then the empty state is shown', async () => {
      await render();
      await respondWith(aBoardPage([]));

      expect(textOf(fixture), 'text of an empty list').toContain('You have no boards yet.');
    });

    it('when the backend fails then an alert with the request id is shown', async () => {
      await render();

      expectRequest('GET', '/api/boards').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert text').toContain('req-500');
    });

    it('when Try again is clicked after a failure then the list is requested again', async () => {
      await render();
      expectRequest('GET', '/api/boards').flush(
        aProblem({ status: 500 }),
        problemResponse(500, 'Server Error'),
      );
      await settle();
      await fixture.whenStable();

      buttonByText(fixture, 'Try again').click();
      await settle();

      await respondWith();
      expect(all(fixture, 'article').length, 'cards after retry').toBe(1);
    });
  });

  describe('create', () => {
    it('when boards are listed then a New board card and the sidebar button are offered', async () => {
      await render();
      await respondWith();

      const labels = all(fixture, 'drawboard-board-create button').map((b) =>
        b.textContent?.trim(),
      );
      expect(labels, 'create entry points').toEqual(['New board', 'New board']);
    });
  });

  describe('view and search', () => {
    const boards = [
      aBoard({ title: 'Old retro', updatedAt: '2026-10-01T10:00:00Z' }),
      aBoard({
        id: RETRO_BOARD_ID,
        title: 'Sprint planning',
        role: BoardRole.EDITOR,
        updatedAt: '2026-11-05T10:00:00Z',
      }),
    ];
    const titles = (): string[] =>
      all(fixture, 'article a').map((a) => a.textContent?.trim() ?? '');
    const search = (text: string): Promise<void> => {
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        '#library-search',
      ) as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new Event('input'));
      return fixture.whenStable();
    };

    it('when listed in the recent view then the most recently edited board comes first', async () => {
      await render();
      await respondWith(aBoardPage(boards));

      expect(titles(), 'order').toEqual(['Sprint planning', 'Old retro']);
      expect(textOf(fixture), 'heading').toContain('Recent');
    });

    it('when ?view=mine is in the URL then the top level is shown with a New board card', async () => {
      view.set('mine');
      await render();
      await respondWith(aBoardPage(boards));

      expect(titles(), 'boards of the top level').toEqual(['Sprint planning', 'Old retro']);
      expect(textOf(fixture), 'heading').toContain('My boards');
    });

    it('when a search text is typed then the loaded boards are filtered by title', async () => {
      await render();
      await respondWith(aBoardPage(boards));

      await search('RETRO');

      expect(titles(), 'matches').toEqual(['Old retro']);
    });

    it('when nothing matches the search then the empty state names the text', async () => {
      await render();
      await respondWith(aBoardPage(boards));

      await search('zzz');

      expect(all(fixture, '[data-testid=empty]')[0]?.textContent, 'empty state').toContain('“zzz”');
    });
  });

  describe('changes of a card', () => {
    it('when a card reports a deleted board then the list is requested again', async () => {
      await render();
      await respondWith();

      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Move to trash').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Yes, move to trash').click();
      await settle();
      expectRequest('DELETE', `/api/boards/${aBoard().id}`).flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      await respondWith(aBoardPage([]));
      expect(textOf(fixture), 'text after deleting').toContain('You have no boards yet.');
    });
  });

  describe('folders', () => {
    it('when ?view=mine has folders at the top level then a card per top level folder is shown', async () => {
      view.set('mine');
      await render([work, team]);
      await respondWith(aBoardPage([]));

      const cards = all(fixture, 'drawboard-folder-card').map((c) => c.textContent?.trim());
      expect(cards.length, 'folder cards').toBe(1);
      expect(cards[0], 'card').toContain('Work');
    });

    it('when a folder is open then its boards are requested by folder id and its subfolders are shown', async () => {
      view.set('mine');
      folder.set(WORK_FOLDER_ID);
      await render([work, team]);
      expectRequest('GET', `/api/folders/${WORK_FOLDER_ID}`, 'get folder').flush(work);
      const request = expectRequest('GET', '/api/boards', 'list boards of the folder');
      expect(request.request.params.get('folderId'), 'folder parameter').toBe(WORK_FOLDER_ID);
      request.flush(aBoardPage([aBoard({ folderId: WORK_FOLDER_ID })]));
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'heading and card').toContain('Work');
      expect(
        all(fixture, 'drawboard-folder-card').map((c) => c.textContent?.trim()),
        'subfolders',
      ).toEqual(['Team Owner']);
      expect(all(fixture, 'drawboard-board-card').length, 'boards').toBe(1);
      expect(all(fixture, '[data-testid=up]').length, 'up link').toBe(1);
    });

    it('when an empty folder is open then the empty state says so', async () => {
      view.set('mine');
      folder.set(WORK_FOLDER_ID);
      await render([work]);
      expectRequest('GET', `/api/folders/${WORK_FOLDER_ID}`).flush(work);
      await respondWith(aBoardPage([]));

      expect(textOf(fixture), 'empty state').toContain('This folder is empty.');
    });
  });

  describe('shared with me', () => {
    it('when ?view=shared is open then boards and folders of others are listed without a New board card', async () => {
      view.set('shared');
      await render();
      expectRequest('GET', '/api/boards/shared', 'shared with me').flush({
        boards: [aBoard({ title: 'Their board', role: BoardRole.EDITOR, ownerId: 'id-bob' })],
        folders: [aFolder({ name: 'Their folder', role: BoardRole.VIEWER, ownerId: 'id-bob' })],
      });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'heading').toContain('Shared with me');
      expect(textOf(fixture), 'board').toContain('Their board');
      expect(textOf(fixture), 'folder').toContain('Their folder');
      expect(all(fixture, 'drawboard-board-create button').length, 'create entry points').toBe(0);
      expect(all(fixture, 'drawboard-pager').length, 'pager').toBe(0);
    });

    it('when a shared folder is open then its boards and subfolders are requested with the folder id', async () => {
      view.set('shared');
      folder.set(WORK_FOLDER_ID);
      await render();
      expectRequest('GET', `/api/folders/${WORK_FOLDER_ID}`).flush(
        aFolder({ role: BoardRole.VIEWER, ownerId: 'id-bob' }),
      );
      const subfolders = expectRequest('GET', '/api/folders', 'subfolders');
      expect(subfolders.request.params.get('parentId'), 'parent parameter').toBe(WORK_FOLDER_ID);
      subfolders.flush({ items: [team] });
      await respondWith(aBoardPage([aBoard({ role: BoardRole.VIEWER })]));

      expect(textOf(fixture), 'subfolder').toContain('Team');
      expect(all(fixture, 'drawboard-board-card').length, 'boards').toBe(1);
      expect(
        all(fixture, 'drawboard-board-create button').length,
        'no create in a folder of others',
      ).toBe(0);
    });

    it('when nothing is shared then the empty state says so', async () => {
      view.set('shared');
      await render();
      expectRequest('GET', '/api/boards/shared').flush({ boards: [], folders: [] });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'empty state').toContain(
        'Nothing has been shared with you here yet.',
      );
    });
  });

  describe('trash', () => {
    it('when ?view=trash is open then the trash list is shown and no boards are requested', async () => {
      view.set('trash');
      await render();
      expectRequest('GET', '/api/trash', 'list trash').flush({ boards: [], folders: [] });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'trash').toContain('The trash is empty.');
    });
  });

  describe('moving boards', () => {
    it('when a board is dropped on My boards then it moves to the top level and the list reloads', async () => {
      view.set('mine');
      await render();
      const inFolder = aBoard({ folderId: WORK_FOLDER_ID, version: 3 });
      await respondWith(aBoardPage([]));
      TestBed.inject(BoardMover).dragged.set(inFolder);

      all(fixture, 'nav a')[1].dispatchEvent(new Event('drop', { cancelable: true }));
      await settle();
      const move = expectRequest('PUT', `/api/boards/${inFolder.id}/folder`, 'move board');
      expect(move.request.body, 'move body').toEqual({ folderId: null, version: 3 });
      move.flush(aBoard());
      await settle();

      await respondWith(aBoardPage([aBoard()]));
      expect(all(fixture, 'drawboard-board-card').length, 'boards after the move').toBe(1);
    });
  });
});
