import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { Toasts } from '../../../../services/toasts';
import { all, buttonByLabel, buttonByText, linkByText, textOf } from '../../../../test/dom';
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
import { BoardTemplates } from '../board-templates';
import { TemplateList } from './template-list';

describe('TemplateList', () => {
  let fixture: ComponentFixture<TemplateList>;
  let navigate: ReturnType<typeof vi.spyOn>;
  const page = signal(0);
  const search = signal('');

  const mine = aBoard({ title: 'Our retro', template: true });
  const shared = aBoard({ id: RETRO_BOARD_ID, title: 'Their kanban', template: true });

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(TemplateList, {
      bindings: [inputBinding('page', page), inputBinding('search', search)],
    });
    await settle();
  }

  async function answer(body = aBoardPage([mine, shared])): Promise<void> {
    expectRequest('GET', '/api/templates', 'list templates').flush(body);
    await settle();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in loaded').toBe(8),
    );
  }

  /** The files question is not asked for a template without files. */
  const noFiles = (): void => {
    vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
      count: 0,
      bytes: 0,
    });
  };

  const cardTitles = (): string[] =>
    all(fixture, '[data-testid=templates] h3').map((h) => h.textContent?.trim() ?? '');

  beforeEach(() => {
    page.set(0);
    search.set('');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('listing', () => {
    it('when the page opens then the built-in templates and the templates of the user are listed', async () => {
      await render();
      await answer();

      expect(cardTitles(), 'user templates').toEqual(['Our retro', 'Their kanban']);
      expect(
        all(fixture, '[data-testid=builtin-title]').map((t) => t.textContent?.trim()),
        'built-in',
      ).toContain('Retro: Start, Stop, Continue');
    });

    it('when ?page=2 is in the URL then the second page is requested', async () => {
      page.set(1);
      await render();

      const request = expectRequest('GET', '/api/templates', 'list templates');
      expect(request.request.params.get('page'), 'page').toBe('1');
      expect(request.request.params.get('size'), 'size').toBe('12');
      request.flush(aBoardPage([mine], 1, 2));
    });

    it('when there is more than one page then the pager shows', async () => {
      await render();
      await answer(aBoardPage([mine], 0, 3));

      expect(textOf(fixture), 'pager').toContain('Page 1 of 3');
    });

    it('when the user has no templates then a hint is shown but the built-in ones stay', async () => {
      await render();
      await answer(aBoardPage([]));

      expect(textOf(fixture), 'hint').toContain('You have no templates yet.');
      expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in').toBe(8);
    });

    it('when the request fails then an alert with the request id is shown', async () => {
      await render();

      expectRequest('GET', '/api/templates').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('req-500');
    });

    it('when a search text is given then both lists are filtered by title', async () => {
      await render();
      await answer();

      search.set('kanban');
      await fixture.whenStable();

      expect(cardTitles(), 'user templates').toEqual(['Their kanban']);
      expect(
        all(fixture, '[data-testid=builtin-title]').map((t) => t.textContent?.trim()),
        'built-in',
      ).toEqual(['Kanban']);
    });
  });

  describe('use', () => {
    it('when Use is clicked on a built-in template then a board is made from it and opened', async () => {
      await render();
      await answer();
      const copy = vi
        .spyOn(TestBed.inject(BoardTemplates), 'fromBuiltin')
        .mockResolvedValue(aBoard({ id: SPRINT_BOARD_ID }));

      buttonByLabel(fixture, 'Use Kanban').click();
      await settle();

      expect(copy.mock.calls[0]?.[0].id, 'template').toBe('kanban');
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', SPRINT_BOARD_ID]);
    });

    it('when Use is clicked on one of my templates then a copy is made and opened', async () => {
      await render();
      await answer();
      const copy = vi
        .spyOn(TestBed.inject(BoardTemplates), 'fromBoard')
        .mockResolvedValue(aBoard({ id: SPRINT_BOARD_ID }));
      noFiles();

      buttonByLabel(fixture, 'Use Our retro').click();
      await settle();

      expect(copy, 'copy').toHaveBeenCalledWith(mine, { files: true });
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', SPRINT_BOARD_ID]);
    });

    it('when the copy fails then nobody navigates and Use works again', async () => {
      await render();
      await answer();
      vi.spyOn(TestBed.inject(BoardTemplates), 'fromBoard').mockResolvedValue(undefined);
      noFiles();

      buttonByLabel(fixture, 'Use Our retro').click();
      await settle();
      await fixture.whenStable();

      expect(navigate, 'no navigation').not.toHaveBeenCalled();
      expect(buttonByLabel(fixture, 'Use Our retro').disabled, 'usable again').toBe(false);
    });

    it('when a copy is running then every Use button is disabled', async () => {
      await render();
      await answer();
      let finish: (value: undefined) => void = () => undefined;
      vi.spyOn(TestBed.inject(BoardTemplates), 'fromBoard').mockReturnValue(
        new Promise((resolve) => (finish = resolve)),
      );
      noFiles();

      buttonByLabel(fixture, 'Use Our retro').click();
      await fixture.whenStable();

      expect(buttonByLabel(fixture, 'Use Their kanban').disabled, 'other card').toBe(true);
      expect(buttonByLabel(fixture, 'Use Kanban').disabled, 'built-in card').toBe(true);
      finish(undefined);
      await settle();
    });

    it('when Open is clicked then the link leads to the template board', async () => {
      await render();
      await answer();

      expect(linkByText(fixture, 'Open').getAttribute('href'), 'link').toBe(
        `/boards/${SPRINT_BOARD_ID}`,
      );
    });
  });

  describe('template with files', () => {
    async function useWithFiles(): Promise<ReturnType<typeof vi.spyOn>> {
      await render();
      await answer();
      vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
        count: 2,
        bytes: 5_000_000,
      });
      const copy = vi
        .spyOn(TestBed.inject(BoardTemplates), 'fromBoard')
        .mockResolvedValue(aBoard({ id: SPRINT_BOARD_ID }));
      buttonByLabel(fixture, 'Use Our retro').click();
      await settle();
      await fixture.whenStable();
      return copy;
    }

    it('when the template has files then number and size are shown before anything is copied', async () => {
      const copy = await useWithFiles();

      expect(textOf(fixture), 'question').toContain('2 files (5.0 MB together)');
      expect(copy, 'not copied yet').not.toHaveBeenCalled();
    });

    it('when Copy without files is chosen then the copy leaves the files out', async () => {
      const copy = await useWithFiles();

      buttonByText(fixture, 'Copy without files').click();
      await settle();

      expect(copy, 'copy').toHaveBeenCalledWith(mine, { files: false });
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', SPRINT_BOARD_ID]);
    });

    it('when Copy with files is chosen then the files are copied', async () => {
      const copy = await useWithFiles();

      buttonByText(fixture, 'Copy with files').click();
      await settle();

      expect(copy, 'copy').toHaveBeenCalledWith(mine, { files: true });
    });

    it('when the question is cancelled then nothing is copied', async () => {
      const copy = await useWithFiles();

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(copy, 'copy').not.toHaveBeenCalled();
      expect(all(fixture, 'drawboard-template-files-dialog').length, 'dialog').toBe(0);
    });
  });

  describe('rate limit', () => {
    it('when listing is answered with 429 then the friendly text shows and no toast appears', async () => {
      await render();

      expectRequest('GET', '/api/templates').flush(
        aProblem({ code: 'TOO_MANY_REQUESTS', status: 429 }),
        problemResponse(429, 'Too Many Requests'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'text').toContain('Too many requests');
      expect(TestBed.inject(Toasts).toasts(), 'toasts').toEqual([]);
    });
  });

  describe('owners', () => {
    it('when the templates belong to the user then the cards say so', async () => {
      await render();
      await answer(aBoardPage([mine]));

      expect(textOf(fixture), 'owner').toContain('By You');
    });
  });
});
