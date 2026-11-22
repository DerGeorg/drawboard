import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Board } from '@apps/drawboard-api';

import { loadBuiltinTemplates } from '@apps/drawboard-engine';
import { Toasts } from '../../../../services/toasts';
import { all, buttonByText, textOf } from '../../../../test/dom';
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
import { EMPTY_CHOICE, TemplateChoice, TemplatePicker, choiceTitle } from './template-picker';

describe('TemplatePicker', () => {
  let fixture: ComponentFixture<TemplatePicker>;
  const choice = signal<TemplateChoice>(EMPTY_CHOICE);
  const changed = vi.fn();

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(TemplatePicker, {
      bindings: [inputBinding('choice', choice), outputBinding('choiceChange', changed)],
    });
    await settle();
  }

  async function answer(page: ReturnType<typeof aBoardPage>): Promise<void> {
    expectRequest('GET', '/api/templates', 'list templates').flush(page);
    await settle();
    await fixture.whenStable();
  }

  const titles = (): string[] =>
    all(fixture, '[data-testid=template-title]').map((t) => t.textContent?.trim() ?? '');

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    choice.set(EMPTY_CHOICE);
    changed.mockClear();
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('lists', () => {
    it('when the dialog opens then the first page of 12 templates is requested', async () => {
      await render();

      const request = expectRequest('GET', '/api/templates', 'list templates');
      expect(request.request.params.get('page'), 'page').toBe('0');
      expect(request.request.params.get('size'), 'size').toBe('12');
      request.flush(aBoardPage([]));
    });

    it('when the answer arrives then the user templates and the eight built-in ones are listed', async () => {
      await render();
      await answer(aBoardPage([aBoard({ title: 'Our retro', template: true })]));
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in').toBe(8),
      );

      expect(titles(), 'own templates').toEqual(['Our retro']);
    });

    it('when there are no templates then a hint explains how to make one', async () => {
      await render();
      await answer(aBoardPage([]));

      expect(textOf(fixture), 'hint').toContain('Save as template');
    });

    it('when the request fails then a retry is offered and works', async () => {
      await render();
      expectRequest('GET', '/api/templates').flush(
        aProblem({ status: 500 }),
        problemResponse(500, 'Server Error'),
      );
      await settle();
      await fixture.whenStable();

      buttonByText(fixture, 'Try again').click();
      await settle();
      await answer(aBoardPage([aBoard({ title: 'Back again' })]));

      expect(titles(), 'templates after retry').toEqual(['Back again']);
    });
  });

  describe('paging', () => {
    it('when more pages exist then Load more asks for the next one and appends it', async () => {
      await render();
      await answer(aBoardPage([aBoard({ title: 'First' })], 0, 2));

      buttonByText(fixture, 'Load more').click();
      await settle();
      const request = expectRequest('GET', '/api/templates', 'second page');
      expect(request.request.params.get('page'), 'page').toBe('1');
      request.flush(aBoardPage([aBoard({ id: RETRO_BOARD_ID, title: 'Second' })], 1, 2));
      await settle();
      await fixture.whenStable();

      expect(titles(), 'both pages').toEqual(['First', 'Second']);
      expect(
        all(fixture, 'button').some((b) => b.textContent?.trim() === 'Load more'),
        'no more button after the last page',
      ).toBe(false);
    });

    it('when there is only one page then there is no Load more', async () => {
      await render();
      await answer(aBoardPage([aBoard()], 0, 1));

      expect(
        all(fixture, 'button').some((b) => b.textContent?.trim() === 'Load more'),
        'Load more',
      ).toBe(false);
    });
  });

  describe('choosing', () => {
    it('when a user template is clicked then it is the choice', async () => {
      const mine: Board = aBoard({ title: 'Our retro', template: true });
      await render();
      await answer(aBoardPage([mine]));

      (
        all(fixture, 'label')
          .find((l) => l.textContent?.includes('Our retro'))
          ?.querySelector('input') as HTMLInputElement
      ).click();

      expect(changed, 'choice').toHaveBeenCalledWith({ kind: 'board', board: mine });
    });

    it('when a built-in template is clicked then it is the choice', async () => {
      await render();
      await answer(aBoardPage([]));
      await vi.waitFor(() =>
        expect(all(fixture, '[data-testid=builtin-title]').length, 'built-in cards').toBe(8),
      );

      (
        all(fixture, 'label')
          .find((l) => l.textContent?.includes('SWOT'))
          ?.querySelector('input') as HTMLInputElement
      ).click();

      expect(changed.mock.calls[0]?.[0].kind, 'kind').toBe('builtin');
      expect(changed.mock.calls[0]?.[0].template.id, 'template').toBe('swot');
    });

    it('when the choice is a user template then only its radio is checked', async () => {
      const mine = aBoard({ title: 'Our retro' });
      choice.set({ kind: 'board', board: mine });
      await render();
      await answer(aBoardPage([mine]));

      const checked = all<HTMLInputElement>(fixture, 'input[type=radio]').filter((r) => r.checked);
      expect(checked.length, 'checked radios').toBe(1);
      expect(checked[0]?.closest('label')?.textContent, 'which').toContain('Our retro');
    });
  });

  describe('choiceTitle', () => {
    it('when a choice is asked for its title then boards and templates answer and the empty board does not', async () => {
      expect(choiceTitle(EMPTY_CHOICE), 'empty').toBeUndefined();
      expect(choiceTitle({ kind: 'board', board: aBoard({ title: 'X' }) }), 'board').toBe('X');
      expect(
        choiceTitle({ kind: 'builtin', template: (await loadBuiltinTemplates())[3] }),
        'built-in',
      ).toBe('Kanban');
    });
  });

  describe('groups and owners', () => {
    it('when the picker opens then the built-in templates have a group of their own', async () => {
      await render();
      await answer(aBoardPage([]));

      const headings = all(fixture, 'h3').map((h) => h.textContent?.trim());
      expect(headings, 'groups').toEqual(['Built-in', 'Templates on this instance']);
    });

    it("when a template is the user's own then the row says By You", async () => {
      await render();
      await answer(aBoardPage([aBoard({ title: 'Mine', ownerId: 'id-alice' })]));

      expect(all(fixture, '[data-testid=template-meta]')[0]?.textContent, 'meta').toContain(
        'By You',
      );
    });

    it('when the owner of a template is someone else then the name from the member list is shown', async () => {
      await render();
      expectRequest('GET', '/api/templates').flush(
        aBoardPage([aBoard({ title: 'Theirs', ownerId: 'id-bob' })]),
      );
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush({
        owner: { kind: 'USER', userId: 'id-bob', displayName: 'Bob Builder', username: 'bob' },
        items: [],
      });
      await settle();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=template-meta]')[0]?.textContent, 'meta').toContain(
        'By Bob Builder',
      );
    });
  });

  describe('rate limit', () => {
    it('when the list answers 429 then the friendly text shows inline and no toast appears', async () => {
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
});
