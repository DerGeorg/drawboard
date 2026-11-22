import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  KANBAN_TYPE,
  KanbanModel,
  newKanbanProps,
  STORY_TYPE,
  readStory,
  STICKY_TYPE,
  BoardDoc,
} from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../board-engine/engine';
import { buttonByLabel, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { BOB, STAFF, aMember, aMemberList } from '../testing/share';
import { BoardKanbanCard, assignableNames } from './board-kanban-card';

describe('BoardKanbanCard', () => {
  let fixture: ComponentFixture<BoardKanbanCard>;
  let board: BoardDoc;
  let engine: BoardEngine;
  let model: KanbanModel;
  let blockId: string;
  let cardId: string;
  let closed: number;
  const guest = signal(false);

  async function render(readOnly = false, prepare?: () => void): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    board = new BoardDoc();
    engine = new BoardEngine(document.createElement('div'), board, { readOnly });
    blockId = board.addBlock({
      type: KANBAN_TYPE,
      x: 0,
      y: 0,
      w: 700,
      h: 400,
      props: newKanbanProps(),
    });
    model = new KanbanModel(board, blockId);
    cardId = model.addCard(model.read().columns[0]?.id as string, 'Write docs') as string;
    model.updateCard(cardId, { assignee: 'Former Member', labels: ['red'] });
    prepare?.();
    closed = 0;
    fixture = TestBed.createComponent(BoardKanbanCard, {
      bindings: [
        inputBinding('engine', () => engine),
        inputBinding('boardId', () => SPRINT_BOARD_ID),
        inputBinding('blockId', () => blockId),
        inputBinding('cardId', () => cardId),
        inputBinding('guest', guest),
        outputBinding('closed', () => closed++),
      ],
    });
    await settle();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const field = (selector: string): HTMLInputElement =>
    el().querySelector(selector) as HTMLInputElement;
  function set(selector: string, value: string): void {
    const input = field(selector);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  }
  async function submit(): Promise<void> {
    (el().querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await settle();
  }
  const members = (): void =>
    expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush(
      aMemberList([aMember(BOB), aMember(STAFF, 'VIEWER')]),
    );

  beforeEach(() => guest.set(false));
  afterEach(() => {
    engine.destroy();
    board.destroy();
  });

  describe('opening', () => {
    it('when opened then the card is shown and the assignee is picked from the members', async () => {
      await render();
      members();
      await fixture.whenStable();

      expect(field('input[type=text]').value, 'title').toBe('Write docs');
      const options = Array.from(el().querySelectorAll('option')).map((o) => o.textContent?.trim());
      expect(options, 'nobody, the former assignee, owner and users - no groups').toEqual([
        'Nobody',
        'Former Member',
        'Alice Admin',
        'Bob Builder',
      ]);
    });

    it('when the form is saved then every field is written as one undo step', async () => {
      await render();
      members();
      await fixture.whenStable();

      set('input[type=text]', 'Write the docs');
      set('select', 'Bob Builder');
      set('input[type=date]', '2026-12-24');
      set('input[inputmode=numeric]', '8');
      buttonByText(fixture, 'Green').click();
      buttonByText(fixture, 'Red').click();
      await fixture.whenStable();
      await submit();

      expect(model.card(cardId), 'stored').toMatchObject({
        title: 'Write the docs',
        assignee: 'Bob Builder',
        due: '2026-12-24',
        points: 8,
        labels: ['green'],
      });
      expect(closed, 'closed after saving').toBe(1);
      engine.undo();
      expect(model.card(cardId)?.title, 'one undo step').toBe('Write docs');
    });

    it('when the points are not a number then nothing is saved', async () => {
      await render();
      members();

      set('input[inputmode=numeric]', 'lots');
      await submit();

      expect(model.card(cardId)?.points, 'unchanged').toBeNull();
      expect(textOf(fixture), 'message').toContain('A whole number from 0 to 999.');
    });
  });

  describe('guests', () => {
    it('when a guest opens a card then no members are loaded and the name is shown', async () => {
      guest.set(true);
      await render();

      expect(textOf(fixture), 'name').toContain('Former Member');
      expect(el().querySelector('select'), 'no picker').toBeNull();
      set('input[type=text]', 'Guest edit');
      await submit();
      expect(model.card(cardId)?.assignee, 'assignee untouched').toBe('Former Member');
    });

    it('when the members cannot be loaded then the panel says so and still works', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush(
        null,
        problemResponse(403, 'Forbidden'),
      );
      await settle();

      expect(textOf(fixture), 'hint').toContain('The members could not be loaded.');
    });
  });

  describe('actions', () => {
    it('when "Move to canvas" is clicked then the card becomes a selected sticky note', async () => {
      await render();
      members();

      buttonByText(fixture, 'Move to canvas').click();
      await fixture.whenStable();

      const sticky = board.blocks().find((b) => b.type === STICKY_TYPE);
      expect(board.textOf(sticky?.id as string), 'sticky').toBe('Write docs');
      expect(engine.selection.list(), 'selected').toEqual([sticky?.id]);
      expect(closed, 'the card is gone, the panel closes').toBe(1);
    });

    it('when the card is deleted then the panel closes', async () => {
      await render();
      members();

      buttonByLabel(fixture, 'Delete the card').click();

      expect(model.card(cardId), 'deleted').toBeUndefined();
      expect(closed, 'closed').toBe(1);
    });
  });

  describe('story details', () => {
    const C1 = '55555555-5555-4555-8555-555555555555';
    const C2 = '66666666-6666-4666-8666-666666666666';
    const description = (): HTMLTextAreaElement =>
      el().querySelector('textarea') as HTMLTextAreaElement;
    const criteria = (): HTMLElement[] =>
      Array.from(el().querySelectorAll<HTMLElement>('[data-testid=criterion]'));
    const criterionText = (i: number): HTMLInputElement =>
      criteria()[i]?.querySelector('input[type=text]') as HTMLInputElement;

    async function renderWithDetails(readOnly = false): Promise<void> {
      await render(readOnly, () =>
        model.updateCard(cardId, {
          description: 'Pay with <b>card</b>',
          estimate: '?',
          criteria: [
            { id: C1, text: '<i>Accepted</i>', done: true },
            { id: C2, text: 'Receipt', done: false },
          ],
        }),
      );
      members();
      await fixture.whenStable();
    }

    it('when a card has no details then the fields are empty and criteria can be added', async () => {
      await render();
      members();
      await fixture.whenStable();

      expect(description().value, 'empty description').toBe('');
      expect(criteria(), 'no criteria').toHaveLength(0);
      field('input[placeholder="Add a criterion"]').value = 'First one';
      buttonByText(fixture, 'Add').click();
      await fixture.whenStable();
      expect(criteria(), 'added to the draft').toHaveLength(1);
      expect(model.card(cardId)?.criteria, 'not saved yet').toEqual([]);

      set('textarea', 'Because');
      await submit();

      expect(model.card(cardId), 'saved').toMatchObject({
        description: 'Because',
        criteria: [{ text: 'First one', done: false }],
      });
    });

    it('when a card has details then they are shown as plain text', async () => {
      await renderWithDetails();

      expect(description().value, 'description as typed').toBe('Pay with <b>card</b>');
      expect(el().querySelector('b, i'), 'no markup anywhere').toBeNull();
      expect(criterionText(0).value, 'criterion text').toBe('<i>Accepted</i>');
      expect(
        (criteria()[0]?.querySelector('input[type=checkbox]') as HTMLInputElement).checked,
        'done',
      ).toBe(true);
    });

    it('when description and criteria are edited and saved then one undo step brings everything back', async () => {
      await renderWithDetails();
      engine.stopCapturing();

      set('textarea', 'Changed');
      (criteria()[1]?.querySelector('input[type=checkbox]') as HTMLInputElement).click();
      criterionText(0).value = 'Reworded';
      criterionText(0).dispatchEvent(new Event('change'));
      buttonByLabel(fixture, 'Remove criterion 2').click();
      field('input[placeholder="Add a criterion"]').value = 'Brand new';
      buttonByText(fixture, 'Add').click();
      await fixture.whenStable();
      await submit();

      expect(model.card(cardId), 'saved').toMatchObject({
        description: 'Changed',
        estimate: '?',
        criteria: [
          { id: C1, text: 'Reworded', done: true },
          { text: 'Brand new', done: false },
        ],
      });
      engine.undo();
      expect(model.card(cardId), 'undone').toMatchObject({
        description: 'Pay with <b>card</b>',
        criteria: [{ text: '<i>Accepted</i>' }, { text: 'Receipt' }],
      });
    });

    it('when the description is too long then nothing is saved', async () => {
      await renderWithDetails();

      set('textarea', 'x'.repeat(10_001));
      await submit();

      expect(model.card(cardId)?.description, 'unchanged').toBe('Pay with <b>card</b>');
      expect(textOf(fixture), 'message').toContain('At most 10000 characters.');
    });

    it('when "Move to canvas" is clicked on a card with details then it becomes a story card', async () => {
      await renderWithDetails();

      buttonByText(fixture, 'Move to canvas').click();
      await fixture.whenStable();

      expect(
        board.blocks().map((b) => b.type),
        'a story card and no sticky',
      ).toEqual([KANBAN_TYPE, STORY_TYPE]);
      expect(
        readStory(board, board.blocks().find((b) => b.type === STORY_TYPE)?.id as string)
          .description,
        'description kept',
      ).toBe('Pay with <b>card</b>');
    });

    it('when the kanban has no room for more description text then Save shows why and stays open', async () => {
      await renderWithDetails();
      for (let i = 0; i < 26; i++) {
        const other = model.addCard(model.read().columns[0]?.id as string, `O${i}`) as string;
        model.updateCard(other, { description: 'x'.repeat(10_000) });
      }

      set('textarea', 'y'.repeat(10_000));
      await submit();

      expect(el().querySelector('[data-testid=save-error]')?.textContent, 'message').toContain(
        'too much description text',
      );
      expect(closed, 'stays open').toBe(0);
      expect(model.card(cardId)?.description, 'unchanged').toBe('Pay with <b>card</b>');
    });

    it('when "As story card" is clicked then a story card keeps description, criteria and estimate', async () => {
      await renderWithDetails();

      buttonByText(fixture, 'As story card').click();
      await fixture.whenStable();

      const story = board.blocks().find((b) => b.type === STORY_TYPE);
      expect(readStory(board, story?.id as string), 'story').toMatchObject({
        title: 'Write docs',
        description: 'Pay with <b>card</b>',
        criteria: [{ id: C1 }, { id: C2 }],
        estimate: '?',
      });
      expect(engine.selection.list(), 'selected').toEqual([story?.id]);
      expect(model.card(cardId), 'card gone').toBeUndefined();
      expect(closed, 'closed').toBe(1);
    });

    it('when the board is read-only then description and criteria cannot be changed', async () => {
      await renderWithDetails(true);

      expect(description().disabled, 'description').toBe(true);
      expect(criterionText(0).readOnly, 'criterion').toBe(true);
      expect(el().querySelector('input[placeholder="Add a criterion"]'), 'no add field').toBeNull();
      expect(buttonByText(fixture, 'As story card').disabled, 'no move').toBe(true);
    });
  });

  describe('read-only', () => {
    it('when the board is read-only then nothing can be changed', async () => {
      await render(true);
      members();
      await fixture.whenStable();

      expect(field('input[type=text]').disabled, 'title disabled').toBe(true);
      expect(buttonByText(fixture, 'Save').disabled, 'no save').toBe(true);
      await submit();
      expect(model.card(cardId)?.title, 'unchanged').toBe('Write docs');
    });

    it('when someone else renames the card then the draft is kept', async () => {
      await render();
      members();
      set('input[type=text]', 'Mine');

      model.updateCard(cardId, { title: 'Theirs' });
      await fixture.whenStable();

      expect(field('input[type=text]').value, 'draft').toBe('Mine');
    });
  });

  describe('helpers', () => {
    it('when members are turned into names then groups and doubles are skipped', () => {
      expect(
        assignableNames(aMemberList([aMember(BOB), aMember(BOB, 'VIEWER', 'f1'), aMember(STAFF)])),
        'names',
      ).toEqual(['Alice Admin', 'Bob Builder']);
    });
  });
});
