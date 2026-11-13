import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Board } from '@apps/drawboard-api';

import { Toasts } from '../../../../services/toasts';
import { all, buttonByText, textOf, typeInto } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import {
  RETRO_BOARD_ID,
  SPRINT_BOARD_ID,
  aBoard,
  aBoardPage,
  aProblem,
} from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { RecordedSpans, parentId, recordSpans } from '../../../../test/tracing';
import { BoardTemplates } from '../board-templates';
import { DEFAULT_TITLE, NewBoardDialog } from './new-board-dialog';

describe('NewBoardDialog', () => {
  let fixture: ComponentFixture<NewBoardDialog>;
  let toasts: Toasts;
  let navigate: ReturnType<typeof vi.spyOn>;
  const folderId = signal<string | undefined>(undefined);
  const closed = vi.fn();

  /** Renders the dialog; the template list of the picker is answered with `templates`. */
  async function render(templates: Board[] = []): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    toasts = TestBed.inject(Toasts);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(NewBoardDialog, {
      bindings: [inputBinding('folderId', folderId), outputBinding('closed', closed)],
    });
    await settle();
    expectRequest('GET', '/api/templates', 'list templates').flush(aBoardPage(templates));
    await settle();
    await fixture.whenStable();
  }

  async function create(): Promise<void> {
    buttonByText(fixture, 'Create board').click();
    await settle();
  }

  const titleInput = (): HTMLInputElement =>
    (fixture.nativeElement as HTMLElement).querySelector('#new-board-title') as HTMLInputElement;

  /** Picks the radio of the card whose title is `title`. */
  async function pick(title: string): Promise<void> {
    const label = all(fixture, 'label').find((l) => l.textContent?.includes(title));
    const radio = label?.querySelector('input') as HTMLInputElement;
    radio.click();
    await fixture.whenStable();
  }

  beforeEach(() => {
    folderId.set(undefined);
    closed.mockClear();
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('empty board', () => {
    it('when the dialog opens then Empty board is chosen and the title is the default', async () => {
      await render();

      expect(titleInput().value, 'title').toBe(DEFAULT_TITLE);
      const radios = all<HTMLInputElement>(fixture, 'input[type=radio]');
      expect(radios[0]?.checked, 'empty board chosen').toBe(true);
    });

    it('when Create board is clicked then a board with the default title is created and opened', async () => {
      await render();

      await create();
      const request = expectRequest('POST', '/api/boards', 'create board');
      expect(request.request.body, 'request body').toEqual({ title: DEFAULT_TITLE });
      request.flush(aBoard(), { status: 201, statusText: 'Created' });
      await settle();

      expect(navigate, 'navigation to the editor').toHaveBeenCalledWith([
        '/boards',
        SPRINT_BOARD_ID,
      ]);
      expect(closed, 'dialog closed').toHaveBeenCalledTimes(1);
    });

    it('when a title is typed then it is used', async () => {
      await render();

      typeInto(fixture, '#new-board-title', '  My own title ');
      await create();

      const request = expectRequest('POST', '/api/boards', 'create board');
      expect(request.request.body, 'request body').toEqual({ title: 'My own title' });
      request.flush(aBoard(), { status: 201, statusText: 'Created' });
      await settle();
    });

    it('when the title is blank then nothing is created and the field says so', async () => {
      await render();

      typeInto(fixture, '#new-board-title', '   ');
      await create();

      expect(textOf(fixture), 'message').toContain('Required.');
    });

    it('when a folder id is given then the board is created in that folder', async () => {
      folderId.set('folder-1');
      await render();

      await create();
      const request = expectRequest('POST', '/api/boards', 'create board');
      expect(request.request.body, 'request body').toEqual({
        title: DEFAULT_TITLE,
        folderId: 'folder-1',
      });
      request.flush(aBoard(), { status: 201, statusText: 'Created' });
      await settle();
    });

    it('when the request is running then Create board is disabled so it cannot be clicked twice', async () => {
      await render();

      await create();

      expect(buttonByText(fixture, 'Create board').disabled, 'disabled while busy').toBe(true);
      expectRequest('POST', '/api/boards').flush(aBoard(), { status: 201, statusText: 'Created' });
      await settle();
    });

    it('when the backend refuses then a toast with the request id is shown and the dialog stays', async () => {
      await render();

      await create();
      expectRequest('POST', '/api/boards').flush(
        aProblem({ code: 'INTERNAL_ERROR', status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();

      expect(toasts.toasts(), 'toasts').toEqual([
        expect.objectContaining({ kind: 'error', requestId: 'req-500' }),
      ]);
      expect(navigate, 'no navigation').not.toHaveBeenCalled();
      expect(closed, 'dialog stays').not.toHaveBeenCalled();
      expect(buttonByText(fixture, 'Create board').disabled, 'usable again').toBe(false);
    });

    it('when Cancel is clicked then the dialog closes', async () => {
      await render();

      buttonByText(fixture, 'Cancel').click();

      expect(closed, 'closed').toHaveBeenCalledTimes(1);
    });
  });

  describe('templates', () => {
    it('when the dialog opens then the built-in templates are offered', async () => {
      await render();
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in cards').toBe(8),
      );

      expect(
        all(fixture, '[data-testid=builtin-title]').map((t) => t.textContent?.trim()),
        'titles',
      ).toContain('Kanban');
    });

    it('when a built-in template is chosen then the title follows and the template is copied', async () => {
      await render();
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in cards').toBe(8),
      );
      const copy = vi
        .spyOn(TestBed.inject(BoardTemplates), 'fromBuiltin')
        .mockResolvedValue(aBoard({ id: RETRO_BOARD_ID }));

      await pick('Retro: 4L');
      expect(titleInput().value, 'title follows the template').toBe('Retro: 4L');
      await create();

      expect(copy.mock.calls[0]?.[0].id, 'template').toBe('retro-4l');
      expect(copy.mock.calls[0]?.[1], 'options').toEqual({
        title: 'Retro: 4L',
        folderId: undefined,
      });
      expect(navigate, 'navigation to the copy').toHaveBeenCalledWith(['/boards', RETRO_BOARD_ID]);
    });

    it('when the user typed a title then choosing a template keeps it', async () => {
      await render();
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in cards').toBe(8),
      );

      typeInto(fixture, '#new-board-title', 'Q4 retro');
      await pick('Kanban');

      expect(titleInput().value, 'own title kept').toBe('Q4 retro');
    });

    it('when Empty board is chosen again then the default title returns', async () => {
      await render();
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in cards').toBe(8),
      );

      await pick('Kanban');
      await pick('Empty board');

      expect(titleInput().value, 'title').toBe(DEFAULT_TITLE);
    });

    it('when one of my templates is chosen then it is copied into the folder with the changed title', async () => {
      folderId.set('folder-1');
      const mine = aBoard({ id: RETRO_BOARD_ID, title: 'Our retro', template: true });
      await render([mine]);
      const copy = vi
        .spyOn(TestBed.inject(BoardTemplates), 'fromBoard')
        .mockResolvedValue(aBoard());
      vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
        count: 0,
        bytes: 0,
      });

      await pick('Our retro');
      expect(titleInput().value, 'title follows the template').toBe('Our retro');
      typeInto(fixture, '#new-board-title', 'Our retro 2');
      await create();

      expect(copy, 'copy').toHaveBeenCalledWith(mine, {
        title: 'Our retro 2',
        folderId: 'folder-1',
        files: true,
      });
    });

    describe('with files', () => {
      async function chooseTemplateWithFiles(): Promise<ReturnType<typeof vi.spyOn>> {
        const mine = aBoard({ id: RETRO_BOARD_ID, title: 'Our retro', template: true });
        await render([mine]);
        const copy = vi
          .spyOn(TestBed.inject(BoardTemplates), 'fromBoard')
          .mockResolvedValue(aBoard());
        vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
          count: 3,
          bytes: 12_400_000,
        });
        await pick('Our retro');
        await create();
        await fixture.whenStable();
        return copy;
      }

      it('when the template has files then the question with number and size comes first', async () => {
        const copy = await chooseTemplateWithFiles();

        expect(textOf(fixture), 'question').toContain('3 files (12.4 MB together)');
        expect(copy, 'not copied yet').not.toHaveBeenCalled();
      });

      it('when Copy without files is chosen then the copy leaves the files out', async () => {
        const copy = await chooseTemplateWithFiles();

        buttonByText(fixture, 'Copy without files').click();
        await settle();

        expect(copy.mock.calls[0]?.[1], 'options').toEqual(
          expect.objectContaining({ title: 'Our retro', files: false }),
        );
        expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', SPRINT_BOARD_ID]);
      });

      it('when the question is cancelled then nothing is copied and the dialog stays', async () => {
        const copy = await chooseTemplateWithFiles();

        const cancel = all<HTMLButtonElement>(fixture, 'button').filter(
          (b) => b.textContent?.trim() === 'Cancel',
        );
        cancel[cancel.length - 1]?.click();
        await fixture.whenStable();

        expect(copy, 'copy').not.toHaveBeenCalled();
        expect(all(fixture, 'drawboard-template-files-dialog').length, 'question').toBe(0);
        expect(closed, 'dialog stays').not.toHaveBeenCalled();
      });
    });

    it('when the copy fails then the dialog stays open', async () => {
      await render();
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in cards').toBe(8),
      );
      vi.spyOn(TestBed.inject(BoardTemplates), 'fromBuiltin').mockResolvedValue(undefined);

      await pick('Kanban');
      await create();

      expect(closed, 'dialog stays').not.toHaveBeenCalled();
      expect(navigate, 'no navigation').not.toHaveBeenCalled();
    });
  });

  describe('tracing', () => {
    let spans: RecordedSpans;

    beforeEach(() => {
      spans = recordSpans();
    });

    afterEach(() => spans.stop());

    it('when a board is created then BoardActions.create is a child of NewBoardDialog.create', async () => {
      await render();

      await create();
      expectRequest('POST', '/api/boards').flush(aBoard());
      await settle();

      expect(parentId(spans.byName('BoardActions.create')), 'parent of BoardActions.create').toBe(
        spans.byName('NewBoardDialog.create').spanContext().spanId,
      );
    });
  });
});
