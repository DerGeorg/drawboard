import * as Y from 'yjs';

import { BlockRequest } from '../renderer/block-registry';
import { TestEngine, createTestEngine } from '../testing/helpers';
import { KANBAN_CARD_ACTION, cardLabel, formatDue } from './kanban';
import {
  KANBAN_TYPE,
  KanbanModel,
  newKanbanProps,
  STICKY_TYPE,
  readStory,
} from '@apps/drawboard-engine';

describe('kanban block', () => {
  let t: TestEngine;
  let id: string;
  let model: KanbanModel;
  let requests: BlockRequest[];

  function setUp(readOnly = false): void {
    t = createTestEngine({ readOnly });
    id = t.board.addBlock({
      type: KANBAN_TYPE,
      x: 0,
      y: 0,
      w: 700,
      h: 400,
      props: newKanbanProps('Sprint 1', ['To do', 'Doing']),
    });
    model = new KanbanModel(t.board, id);
    requests = [];
    t.engine.blockRequested.on((r) => requests.push(r));
  }

  const root = (): HTMLElement => t.container.querySelector('.be-kanban') as HTMLElement;
  const columnIds = (): string[] => model.read().columns.map((c) => c.id);
  const cardEl = (cardId: string): HTMLElement =>
    root().querySelector(`[data-card-id="${cardId}"]`) as HTMLElement;
  const byLabel = (label: string): HTMLButtonElement =>
    root().querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  const input = (): HTMLInputElement => root().querySelector('input') as HTMLInputElement;
  function type(value: string, key = 'Enter'): void {
    input().value = value;
    input().dispatchEvent(new Event('input'));
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  }
  function pointer(el: HTMLElement, type: string, x: number, y: number, init = {}): void {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        button: 0,
        clientX: x,
        clientY: y,
        ...init,
      }),
    );
  }
  function rect(el: Element, left: number, top: number, width: number, height: number): void {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
  }

  afterEach(() => t.destroy());

  describe('rendering', () => {
    it('when a kanban is shown then title, columns and cards with their details appear', () => {
      setUp();
      const card = model.addCard(columnIds()[0] as string, 'Write tests') as string;
      model.updateCard(card, {
        labels: ['red'],
        points: 3,
        assignee: 'Ada Lovelace',
        due: '2099-01-02',
      });

      expect(root().querySelector('.be-kb-title')?.textContent, 'title').toBe('Sprint 1');
      expect(
        Array.from(root().querySelectorAll('.be-kb-col-title')).map((h) => h.textContent),
        'columns',
      ).toEqual(['To do', 'Doing']);
      expect(cardEl(card).textContent, 'card').toContain('Write tests');
      expect(
        (root().querySelector('[data-label="red"]') as HTMLElement).style.background,
        'label colour from the palette',
      ).toBe('rgb(239, 68, 68)');
      expect(root().querySelector('.be-kb-assignee')?.textContent, 'initials').toBe('AL');
      expect(root().querySelector('.be-kb-points')?.textContent, 'points').toBe('3');
      expect(
        (root().querySelector('.be-kb-due') as HTMLElement).dataset['overdue'],
        'not overdue',
      ).toBe('false');
      expect(cardEl(card).getAttribute('aria-label'), 'label for screen readers').toBe(
        'Write tests, assigned to Ada Lovelace, due 2099-01-02, 3 points, labels Red',
      );
    });

    it('when a due date has passed then it is marked overdue', () => {
      setUp();
      const card = model.addCard(columnIds()[0] as string, 'Late') as string;
      model.updateCard(card, { due: '2001-01-01' });

      expect(
        (root().querySelector('.be-kb-due') as HTMLElement).dataset['overdue'],
        'overdue',
      ).toBe('true');
    });

    it('when the board is read-only then nothing can be edited or dragged', () => {
      setUp(true);
      model.addCard(columnIds()[0] as string, 'A');

      expect(root().querySelectorAll('button').length, 'no buttons').toBe(0);
      expect(
        root().querySelector('[data-card-id]')?.hasAttribute('data-be-interactive'),
        'cards are not interactive',
      ).toBe(false);
    });

    it('when the board becomes read-only later then the controls go away', () => {
      setUp();
      expect(root().querySelectorAll('button').length, 'buttons first').toBeGreaterThan(0);

      t.engine.setReadOnly(true);

      expect(root().querySelectorAll('button').length, 'no buttons').toBe(0);
    });

    it('when someone else adds a card then it shows up', () => {
      setUp();
      const remote = new Y.Doc();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(t.board.doc));
      remote.on('update', (u: Uint8Array) => Y.applyUpdate(t.board.doc, u, 'remote'));
      const cards = (remote.getMap('blocks').get(id) as Y.Map<unknown>).get(
        'props',
      ) as Y.Map<unknown>;
      const card = new Y.Map<unknown>();
      card.set('column', columnIds()[1]);
      card.set('order', 1);
      card.set('title', 'From afar');
      (cards.get('cards') as Y.Map<unknown>).set('44444444-4444-4444-8444-444444444444', card);

      expect(root().textContent, 'remote card').toContain('From afar');
    });

    it('when helpers format a date and an untitled card then both read well', () => {
      setUp();
      expect(formatDue('2026-12-24'), 'date').toMatch(/24/);
      expect(
        cardLabel({
          id: 'x',
          column: 'c',
          order: 1,
          title: '',
          assignee: null,
          due: null,
          labels: [],
          points: null,
          description: '',
          criteria: [],
          estimate: null,
        }),
        'untitled',
      ).toBe('Untitled card');
    });

    it('when a card has a description or criteria then a small symbol shows it', () => {
      setUp();
      const plain = model.addCard(columnIds()[0] as string, 'Plain') as string;
      const rich = model.addCard(columnIds()[0] as string, 'Rich') as string;
      model.updateCard(rich, {
        description: 'Why <b>this</b>',
        criteria: [
          { id: '55555555-5555-4555-8555-555555555555', text: 'A', done: true },
          { id: '66666666-6666-4666-8666-666666666666', text: 'B', done: false },
        ],
      });

      expect(cardEl(plain).querySelector('.be-kb-details'), 'plain card').toBeNull();
      const chip = cardEl(rich).querySelector('.be-kb-details') as HTMLElement;
      expect(chip.textContent, 'symbol and progress').toBe('≡ 1/2');
      expect(chip.title, 'tooltip').toBe('Has a description, 1 of 2 acceptance criteria done');
      expect(cardEl(rich).querySelector('b'), 'text stays text').toBeNull();
      expect(cardEl(rich).getAttribute('aria-label'), 'screen reader').toBe(
        'Rich, has a description, 1 of 2 acceptance criteria done',
      );
    });
  });

  describe('columns', () => {
    it('when a column is added through the button then it appears at the end', () => {
      setUp();

      byLabel('Add a column').click();
      type('Review');

      expect(
        model.read().columns.map((c) => c.title),
        'columns',
      ).toEqual(['To do', 'Doing', 'Review']);
    });

    it('when a column is renamed then the new title is stored; Escape keeps the old one', () => {
      setUp();

      byLabel('Rename To do').click();
      type('Backlog');
      byLabel('Rename Doing').click();
      type('nope', 'Escape');

      expect(
        model.read().columns.map((c) => c.title),
        'titles',
      ).toEqual(['Backlog', 'Doing']);
    });

    it('when a column is moved right and then deleted then the rest stays', () => {
      setUp();

      byLabel('Move To do right').click();
      expect(
        model.read().columns.map((c) => c.title),
        'moved',
      ).toEqual(['Doing', 'To do']);
      expect(byLabel('Move Doing left').disabled, 'first cannot move left').toBe(true);
      byLabel('Delete To do and its cards').click();

      expect(
        model.read().columns.map((c) => c.title),
        'deleted',
      ).toEqual(['Doing']);
    });

    it('when the kanban is renamed then the title changes', () => {
      setUp();

      byLabel('Rename the kanban').click();
      type('Sprint 2');

      expect(model.read().title, 'title').toBe('Sprint 2');
    });

    it('when an editor loses the focus then what was typed is kept', () => {
      setUp();

      byLabel('Rename Doing').click();
      input().value = 'Doing now';
      input().dispatchEvent(new Event('input'));
      input().dispatchEvent(new FocusEvent('blur'));

      expect(model.read().columns[1]?.title, 'committed on blur').toBe('Doing now');
    });
  });

  describe('cards', () => {
    it('when cards are typed into the add field then each Enter adds one and the field stays', () => {
      setUp();

      byLabel('Add a card to To do').click();
      type('One');
      type('Two');

      expect(
        model.read().columns[0]?.cards.map((c) => c.title),
        'cards',
      ).toEqual(['One', 'Two']);
      expect(input()?.dataset['editor'], 'still open').toBe('new-card');
      type('', 'Escape');
      expect(root().querySelector('input'), 'closed').toBeNull();
    });

    it('when a card is clicked then the host is asked to open it', () => {
      setUp();
      const card = model.addCard(columnIds()[0] as string, 'A') as string;

      pointer(cardEl(card), 'pointerdown', 10, 10);
      pointer(cardEl(card), 'pointerup', 11, 11);

      expect(requests, 'request').toEqual([
        { blockId: id, action: KANBAN_CARD_ACTION, itemId: card },
      ]);
      expect(t.engine.selection.list(), 'the kanban itself is not selected by it').toEqual([]);
    });
  });

  describe('keyboard', () => {
    it('when Enter is pressed on a card then it opens; Delete removes it and the next gets focus', () => {
      setUp();
      const todo = columnIds()[0] as string;
      const a = model.addCard(todo, 'A') as string;
      const b = model.addCard(todo, 'B') as string;

      key(cardEl(a), 'Enter');
      expect(
        requests.map((r) => r.itemId),
        'opened',
      ).toEqual([a]);

      cardEl(a).focus();
      key(cardEl(a), 'Delete');

      expect(model.card(a), 'deleted').toBeUndefined();
      expect(document.activeElement, 'focus moved on').toBe(cardEl(b));
    });

    it('when Alt+arrows are pressed then the card moves and keeps the focus', () => {
      setUp();
      const [todo, doing] = columnIds() as [string, string];
      const a = model.addCard(todo, 'A') as string;
      model.addCard(todo, 'B');

      cardEl(a).focus();
      key(cardEl(a), 'ArrowDown', { altKey: true });
      expect(
        model.read().columns[0]?.cards.map((c) => c.title),
        'down',
      ).toEqual(['B', 'A']);
      key(cardEl(a), 'ArrowRight', { altKey: true });

      expect(model.card(a)?.column, 'next column').toBe(doing);
      expect(document.activeElement, 'focus kept').toBe(cardEl(a));
    });

    it('when plain arrows are pressed then the focus walks the cards', () => {
      setUp();
      const [todo, doing] = columnIds() as [string, string];
      const a = model.addCard(todo, 'A') as string;
      const b = model.addCard(todo, 'B') as string;
      const c = model.addCard(doing, 'C') as string;

      cardEl(a).focus();
      key(cardEl(a), 'ArrowDown');
      expect(document.activeElement, 'down').toBe(cardEl(b));
      key(cardEl(b), 'ArrowRight');
      expect(document.activeElement, 'right').toBe(cardEl(c));
      key(cardEl(c), 'ArrowLeft');
      key(document.activeElement as HTMLElement, 'ArrowUp');
      expect(document.activeElement, 'left and up').toBe(cardEl(a));
    });

    it('when Delete is pressed on a focused card then the engine does not delete the kanban', () => {
      setUp();
      const a = model.addCard(columnIds()[0] as string, 'A') as string;
      t.engine.selection.set([id]);

      cardEl(a).focus();
      key(cardEl(a), 'Delete');

      expect(t.board.hasBlock(id), 'kanban kept').toBe(true);
    });
  });

  describe('drag', () => {
    function layout(): void {
      rect(root(), 0, 0, 700, 400);
      const cols = Array.from(root().querySelectorAll('[data-column-id]'));
      cols.forEach((col, i) => {
        rect(col, 10 + i * 230, 40, 220, 340);
        Array.from(col.querySelectorAll('[data-card-id]')).forEach((card, j) =>
          rect(card, 16 + i * 230, 80 + j * 50, 208, 40),
        );
      });
    }

    it('when the board is dark then the drag ghost carries the dark theme variables', () => {
      setUp();
      const [todo] = columnIds() as [string];
      const a = model.addCard(todo, 'A') as string;
      layout();
      t.engine.setTheme('dark');

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 260, 120);

      const ghost = document.querySelector('.be-kb-ghost') as HTMLElement;
      expect(ghost.style.getPropertyValue('--be-surface'), 'surface').toBe('#1e293b');
      expect(ghost.style.getPropertyValue('--be-text'), 'text').toBe('#e2e8f0');
      expect(ghost.style.background, 'reads the variable').toContain('--be-surface');
    });

    it('when the board is light then the drag ghost carries the light theme variables', () => {
      setUp();
      const [todo] = columnIds() as [string];
      const a = model.addCard(todo, 'A') as string;
      layout();

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 260, 120);

      expect(
        (document.querySelector('.be-kb-ghost') as HTMLElement).style.getPropertyValue(
          '--be-surface',
        ),
        'surface',
      ).toBe('#ffffff');
    });

    it('when a card is dragged into another column then it lands between the cards there', () => {
      setUp();
      const [todo, doing] = columnIds() as [string, string];
      const a = model.addCard(todo, 'A') as string;
      model.addCard(doing, 'B');
      model.addCard(doing, 'C');
      layout();

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 260, 120);
      expect(document.querySelector('.be-kb-ghost'), 'ghost follows').not.toBeNull();
      expect(root().querySelector('.be-kb-drop'), 'drop marker').not.toBeNull();
      pointer(cardEl(a), 'pointerup', 260, 140);

      expect(
        model.read().columns[1]?.cards.map((c) => c.title),
        'between',
      ).toEqual(['B', 'A', 'C']);
      expect(document.querySelector('.be-kb-ghost'), 'ghost gone').toBeNull();
      expect(requests, 'a drag is no click').toEqual([]);
    });

    it('when a card is dropped outside the kanban then it becomes a selected sticky note', () => {
      setUp();
      const a = model.addCard(columnIds()[0] as string, 'Ship it') as string;
      layout();

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 900, 500);
      expect(
        (document.querySelector('.be-kb-ghost') as HTMLElement).dataset['out'],
        'ghost says out',
      ).toBe('true');
      pointer(cardEl(a), 'pointerup', 900, 500);

      const sticky = t.board.blocks().find((b) => b.type === STICKY_TYPE);
      expect(sticky, 'sticky').toBeDefined();
      expect(t.board.textOf(sticky?.id as string), 'title as text').toBe('Ship it');
      expect(model.card(a), 'card left the kanban').toBeUndefined();
      expect(t.engine.selection.list(), 'selected').toEqual([sticky?.id]);

      t.engine.undo();
      expect(model.card(a)?.title, 'one undo brings it back').toBe('Ship it');
      expect(t.board.blocks().length, 'sticky gone').toBe(1);
    });

    it('when a card with story details is dropped outside then it becomes a story card, not a sticky', () => {
      setUp();
      const a = model.addCard(columnIds()[0] as string, 'Detailed') as string;
      model.updateCard(a, { description: 'Why' });
      layout();

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 900, 500);
      pointer(cardEl(a), 'pointerup', 900, 500);

      expect(
        t.board.blocks().map((b) => b.type),
        'story, no sticky',
      ).toEqual([KANBAN_TYPE, 'core.story']);
      const story = t.board.blocks().find((b) => b.type === 'core.story');
      expect(readStory(t.board, story?.id as string).description, 'kept').toBe('Why');
    });

    it('when a drag is cancelled then nothing changes', () => {
      setUp();
      const a = model.addCard(columnIds()[0] as string, 'A') as string;
      layout();

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 260, 120);
      pointer(cardEl(a), 'pointercancel', 260, 120);

      expect(model.card(a)?.column, 'unchanged').toBe(columnIds()[0]);
      expect(document.querySelector('.be-kb-ghost'), 'ghost gone').toBeNull();
    });

    it('when the document changes during a drag then the view waits for the drop', () => {
      setUp();
      const [todo] = columnIds() as [string];
      const a = model.addCard(todo, 'A') as string;
      layout();

      pointer(cardEl(a), 'pointerdown', 50, 100);
      pointer(cardEl(a), 'pointermove', 60, 300);
      const dragged = cardEl(a);
      model.addCard(todo, 'B');
      expect(cardEl(a), 'same element during the drag').toBe(dragged);
      pointer(dragged, 'pointerup', 300, 395);

      expect(root().textContent, 'rendered after the drop').toContain('B');
    });
  });

  describe('duplicate', () => {
    it('when a kanban is duplicated then the copy has its own columns and cards', () => {
      setUp();
      model.addCard(columnIds()[0] as string, 'A');
      t.engine.selection.set([id]);

      t.engine.duplicateSelection();
      const copy = t.engine.selection.list()[0] as string;
      const copyModel = new KanbanModel(t.board, copy);
      copyModel.addCard(copyModel.read().columns[0]?.id as string, 'Only in the copy');

      expect(
        copyModel.read().columns[0]?.cards.map((c) => c.title),
        'copy',
      ).toEqual(['A', 'Only in the copy']);
      expect(
        model.read().columns[0]?.cards.map((c) => c.title),
        'original untouched',
      ).toEqual(['A']);
    });
  });
});
