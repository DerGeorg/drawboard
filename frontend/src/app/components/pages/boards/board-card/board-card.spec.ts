import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Board, BoardRole } from '@apps/drawboard-api';

import { Toasts } from '../../../../services/toasts';
import {
  all,
  buttonByLabel,
  buttonByText,
  buttonTexts,
  linkByText,
  textOf,
  typeInto,
} from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, aBoard, aFolder, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { RecordedSpans, parentId, recordSpans } from '../../../../test/tracing';
import { BoardMover } from '../board-mover';
import { flushFolders } from '../testing/library';
import { aMemberList } from '../testing/share';
import { BoardCard } from './board-card';

describe('BoardCard', () => {
  let fixture: ComponentFixture<BoardCard>;
  let toasts: Toasts;
  let changed: number;
  const board = signal<Board>(aBoard());

  async function render(overrides: Partial<Board> = {}): Promise<void> {
    changed = 0;
    board.set(aBoard(overrides));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    toasts = TestBed.inject(Toasts);
    fixture = TestBed.createComponent(BoardCard, {
      bindings: [inputBinding('board', board), outputBinding('changed', () => changed++)],
    });
    await fixture.whenStable();
  }

  function fieldErrors(): string[] {
    return all(fixture, '[data-testid=field-error]').map((e) => e.textContent?.trim() ?? '');
  }

  /** Opens the card's menu and picks an entry. */
  async function choose(entry: 'Share…' | 'Rename' | 'Move to…' | 'Move to trash'): Promise<void> {
    buttonByLabel(fixture, 'Board actions').click();
    await fixture.whenStable();
    buttonByText(fixture, entry).click();
    await fixture.whenStable();
  }

  async function startRename(title: string): Promise<void> {
    await choose('Rename');
    typeInto(fixture, `#rename-${SPRINT_BOARD_ID}`, title);
    await fixture.whenStable();
  }

  async function save(): Promise<void> {
    buttonByText(fixture, 'Save').click();
    await settle();
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('rendering', () => {
    it('when shown then the title links to the board and the role is shown', async () => {
      await render();

      expect(linkByText(fixture, 'Sprint planning').getAttribute('href'), 'link to the board').toBe(
        `/${SPRINT_BOARD_ID}`,
      );
      expect(textOf(fixture), 'card text').toContain('Owner');
      expect(all(fixture, '[data-testid=edited]')[0]?.textContent, 'edit time').toMatch(
        /^Edited \S/,
      );
      expect(all(fixture, '[data-testid=preview]').length, 'preview area').toBe(1);
    });

    it('when the user owns the board then Share…, Rename, Move to… and Move to trash are in the menu', async () => {
      await render({ role: BoardRole.OWNER });

      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();

      expect(
        all(fixture, '[role=menuitem]').map((i) => i.textContent?.trim()),
        'menu entries',
      ).toEqual(['Share…', 'Rename', 'Move to…', 'Move to trash']);
    });

    it('when the user is an editor then Share… and Rename but not Move to trash are in the menu', async () => {
      await render({ role: BoardRole.EDITOR });

      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();

      expect(
        all(fixture, '[role=menuitem]').map((i) => i.textContent?.trim()),
        'menu entries',
      ).toEqual(['Share…', 'Rename']);
    });

    it('when the menu is open then Escape and the backdrop close it', async () => {
      await render();
      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();
      expect(all(fixture, '[role=menu]').length, 'after Escape').toBe(0);

      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();
      (all(fixture, 'button.fixed')[0] as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(all(fixture, '[role=menu]').length, 'after the backdrop').toBe(0);
    });

    it.each([BoardRole.COMMENTER, BoardRole.VIEWER])(
      'when the user is a %s then only Share… is offered (the member list, read-only)',
      async (role) => {
        await render({ role });

        buttonByLabel(fixture, 'Board actions').click();
        await fixture.whenStable();

        expect(
          all(fixture, '[role=menuitem]').map((i) => i.textContent?.trim()),
          'menu entries',
        ).toEqual(['Share…']);
      },
    );
  });

  describe('share', () => {
    it('when Share… is chosen then the share dialog of the board opens and Close closes it', async () => {
      await render({ role: BoardRole.EDITOR });
      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Share…').click();
      // NOT whenStable(): the dialog's lists are loading, which is a pending task
      await settle();
      await flushFolders();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush(
        aMemberList(),
      );
      await settle();
      await fixture.whenStable();
      expect(textOf(fixture), 'dialog').toContain('Share board “Sprint planning”');

      buttonByLabel(fixture, 'Close').click();
      await fixture.whenStable();

      expect(all(fixture, 'drawboard-share-dialog').length, 'dialogs').toBe(0);
    });
  });

  describe('rename', () => {
    it('when Rename is chosen then a field with the current title is shown and Cancel closes it', async () => {
      await render();

      await choose('Rename');
      const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        `#rename-${SPRINT_BOARD_ID}`,
      );
      expect(input?.value, 'field value').toBe('Sprint planning');

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(
        all(fixture, 'button[aria-label="Board actions"]').length,
        'menu button is back after Cancel',
      ).toBe(1);
    });

    it('when the title is empty then the client error is shown and nothing is sent', async () => {
      await render();
      await startRename('');

      await save();
      await fixture.whenStable();

      expect(fieldErrors(), 'field errors').toEqual(['Required.']);
      TestBed.inject(HttpTestingController).expectNone(
        `/api/boards/${SPRINT_BOARD_ID}`,
        'no request for an empty title',
      );
    });

    it('when the backend accepts then the version is sent, a toast confirms and the list is told', async () => {
      await render({ version: 4 });
      await startRename('Retro');

      await save();
      const request = expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`, 'rename board');
      expect(request.request.body, 'request body').toEqual({ title: 'Retro', version: 4 });
      request.flush(aBoard({ title: 'Retro', version: 5 }));
      await settle();
      await fixture.whenStable();

      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['Board renamed.']);
      expect(changed, 'changed events').toBe(1);
      expect(
        all(fixture, 'button[aria-label="Board actions"]').length,
        'menu button is back after saving',
      ).toBe(1);
    });

    it('when the version is stale (409) then a toast is shown and the list is told to reload', async () => {
      await render();
      await startRename('Mine');

      await save();
      expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({ code: 'CONFLICT', status: 409, requestId: 'req-409' }),
        problemResponse(409, 'Conflict', 'req-409'),
      );
      await settle();
      await fixture.whenStable();

      expect(toasts.toasts(), 'toasts').toEqual([
        expect.objectContaining({ kind: 'error', requestId: 'req-409' }),
      ]);
      expect(changed, 'changed events').toBe(1);
    });

    it('when the backend rejects the title given only blanks then the violation shows at the field', async () => {
      await render();
      await startRename('   ');

      await save();
      expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({
          code: 'VALIDATION_FAILED',
          status: 400,
          violations: [{ field: 'title', code: 'Pattern', message: 'must match' }],
        }),
        problemResponse(400, 'Bad Request'),
      );
      await settle();
      await fixture.whenStable();

      expect(fieldErrors(), 'server error at the field').toEqual([
        'Must contain at least one character that is not a space.',
      ]);
      expect(toasts.toasts(), 'no toast for a violation shown at the field').toEqual([]);
      expect(changed, 'changed events').toBe(0);
    });

    it('when the backend refuses for another reason then a toast is shown and the field stays open', async () => {
      await render();
      await startRename('Retro');

      await save();
      expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({ code: 'FORBIDDEN', status: 403, requestId: 'req-403' }),
        problemResponse(403, 'Forbidden', 'req-403'),
      );
      await settle();
      await fixture.whenStable();

      expect(toasts.toasts(), 'toasts').toEqual([
        expect.objectContaining({ kind: 'error', requestId: 'req-403' }),
      ]);
      expect(buttonTexts(fixture), 'buttons').toContain('Save');
      expect(changed, 'changed events').toBe(0);
    });
  });

  describe('delete', () => {
    async function confirmDelete(): Promise<void> {
      await choose('Move to trash');
      buttonByText(fixture, 'Yes, move to trash').click();
      await settle();
    }

    it('when the delete is confirmed then the board is deleted and the list is told', async () => {
      await render();

      await confirmDelete();
      expectRequest('DELETE', `/api/boards/${SPRINT_BOARD_ID}`, 'delete board').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expect(changed, 'changed events').toBe(1);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['"Sprint planning" was moved to the trash.']);
    });

    it('when Cancel is clicked in the question then nothing is deleted', async () => {
      await render();

      await choose('Move to trash');
      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(all(fixture, 'button[aria-label="Board actions"]').length, 'menu button is back').toBe(
        1,
      );
      expect(changed, 'changed events').toBe(0);
    });

    it('when the backend refuses then the list is not told', async () => {
      await render();

      await confirmDelete();
      expectRequest('DELETE', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({ code: 'LIBRARY_BOARD_ACCESS_DENIED', status: 403 }),
        problemResponse(403, 'Forbidden'),
      );
      await settle();

      expect(changed, 'changed events').toBe(0);
    });
  });

  describe('tracing', () => {
    let spans: RecordedSpans;

    beforeEach(() => {
      spans = recordSpans();
    });

    afterEach(() => spans.stop());

    it('when a board is renamed then BoardActions.rename is a child of BoardCard.rename', async () => {
      await render();
      await startRename('Retro');

      await save();
      expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`).flush(aBoard());
      await settle();

      expect(parentId(spans.byName('BoardActions.rename')), 'parent of BoardActions.rename').toBe(
        spans.byName('BoardCard.rename').spanContext().spanId,
      );
    });

    it('when a board is deleted then BoardActions.delete is a child of BoardCard.remove', async () => {
      await render();

      await choose('Move to trash');
      buttonByText(fixture, 'Yes, move to trash').click();
      await settle();
      expectRequest('DELETE', `/api/boards/${SPRINT_BOARD_ID}`).flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expect(parentId(spans.byName('BoardActions.delete')), 'parent of BoardActions.delete').toBe(
        spans.byName('BoardCard.remove').spanContext().spanId,
      );
    });
  });

  describe('move and drag', () => {
    it('when the owner picks Move to… and a folder then the board is moved', async () => {
      await render({ version: 2 });
      buttonByLabel(fixture, 'Board actions').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Move to…').click();
      // NOT whenStable(): the folder list is loading, which is a pending task
      await settle();
      expectRequest('GET', '/api/folders', 'list folders').flush({
        items: [aFolder({ id: 'f1', name: 'Work' })],
      });
      await settle();
      await fixture.whenStable();

      buttonByText(fixture, 'Work').click();
      await settle();
      const move = expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}/folder`, 'move board');
      expect(move.request.body, 'move body').toEqual({ folderId: 'f1', version: 2 });
      move.flush(aBoard({ folderId: 'f1' }));
      await settle();

      expect(all(fixture, 'drawboard-folder-picker').length, 'picker closed').toBe(0);
      expect(TestBed.inject(BoardMover).moves(), 'moves').toBe(1);
    });

    it('when the owner starts dragging then the board is remembered, and forgotten at the end', async () => {
      await render();
      const mover = TestBed.inject(BoardMover);
      const article = all(fixture, 'article')[0];

      article.dispatchEvent(new Event('dragstart'));
      expect(article.getAttribute('draggable'), 'draggable').toBe('true');
      expect(mover.dragged()?.id, 'dragged board').toBe(SPRINT_BOARD_ID);

      article.dispatchEvent(new Event('dragend'));
      expect(mover.dragged(), 'dragged after the end').toBeUndefined();
    });

    it('when the user is an editor then the card is not draggable and offers no Move to…', async () => {
      await render({ role: BoardRole.EDITOR });
      const article = all(fixture, 'article')[0];

      article.dispatchEvent(new Event('dragstart'));

      expect(article.getAttribute('draggable'), 'draggable').toBeNull();
      expect(TestBed.inject(BoardMover).dragged(), 'dragged board').toBeUndefined();
    });
  });
});
