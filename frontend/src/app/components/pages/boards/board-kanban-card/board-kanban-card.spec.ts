import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import {
  KANBAN_TYPE,
  KanbanModel,
  newKanbanProps,
} from '../../../../../board-engine/blocks/kanban-model';
import { STICKY_TYPE } from '../../../../../board-engine/blocks/sticky';
import { BoardEngine } from '../../../../../board-engine/engine';
import { BoardDoc } from '../../../../../board-engine/model/board-doc';
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

  async function render(readOnly = false): Promise<void> {
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
