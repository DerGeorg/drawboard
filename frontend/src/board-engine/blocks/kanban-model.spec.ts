import * as Y from 'yjs';

import { History } from '../undo';
import { BoardDoc } from '../model/board-doc';
import {
  KANBAN_LIMITS,
  KANBAN_TYPE,
  KanbanModel,
  isKanbanLabel,
  isValidDueDate,
  kanbanPropsToFile,
  kanbanPropsToY,
  labelColor,
  newKanbanProps,
  orderBetween,
  readKanban,
} from './kanban-model';
import { STICKY_TYPE } from './sticky';

describe('kanban model', () => {
  let board: BoardDoc;
  let history: History;
  let model: KanbanModel;
  let id: string;

  const titles = (): string[][] =>
    model.read().columns.map((c) => [c.title, ...c.cards.map((card) => card.title)]);

  beforeEach(() => {
    board = new BoardDoc();
    history = new History(board);
    id = board.addBlock({
      type: KANBAN_TYPE,
      x: 0,
      y: 0,
      w: 700,
      h: 400,
      props: newKanbanProps('Sprint', ['To do', 'Doing', 'Done']),
    });
    model = new KanbanModel(board, id, () => history.stopCapturing());
    history.stopCapturing();
  });

  afterEach(() => {
    history.destroy();
    board.destroy();
  });

  describe('columns', () => {
    it('when a kanban is created then it has the title and three empty columns in order', () => {
      expect(model.read().title, 'title').toBe('Sprint');
      expect(titles(), 'columns').toEqual([['To do'], ['Doing'], ['Done']]);
    });

    it('when columns are added, renamed, moved and deleted then the order follows', () => {
      const review = model.addColumn('Review') as string;
      model.renameColumn(review, 'In review');
      model.moveColumn(review, 1);
      const doneId = model.read().columns[3]?.id as string;
      model.deleteColumn(doneId);

      expect(titles(), 'columns').toEqual([['To do'], ['In review'], ['Doing']]);
    });

    it('when a column with cards is deleted then its cards go with it', () => {
      const todo = model.read().columns[0]?.id as string;
      model.addCard(todo, 'A');
      model.deleteColumn(todo);

      expect(
        model.read().columns.flatMap((c) => c.cards),
        'no cards',
      ).toEqual([]);
    });

    it('when the column limit is reached then no column is added', () => {
      for (let i = 3; i < KANBAN_LIMITS.maxColumns; i++) {
        model.addColumn(`C${i}`);
      }

      expect(model.addColumn('one too many'), 'refused').toBeUndefined();
      expect(model.read().columns.length, 'count').toBe(KANBAN_LIMITS.maxColumns);
    });
  });

  describe('cards', () => {
    it('when cards are added then they appear at the bottom of their column', () => {
      const todo = model.read().columns[0]?.id as string;
      model.addCard(todo, 'First');
      model.addCard(todo, 'Second');

      expect(titles()[0], 'cards').toEqual(['To do', 'First', 'Second']);
    });

    it('when a card is moved between columns then it lands at the index', () => {
      const [todo, doing] = model.read().columns.map((c) => c.id) as [string, string];
      const a = model.addCard(todo, 'A') as string;
      model.addCard(doing, 'B');
      model.addCard(doing, 'C');

      model.moveCard(a, doing, 1);

      expect(titles(), 'moved').toEqual([['To do'], ['Doing', 'B', 'A', 'C'], ['Done']]);
    });

    it('when a card is moved into the same spot many times then the order stays strict', () => {
      const todo = model.read().columns[0]?.id as string;
      const ids = ['A', 'B', 'C'].map((t) => model.addCard(todo, t) as string);
      for (let i = 0; i < 80; i++) {
        model.moveCard(ids[i % 2 === 0 ? 2 : 1] as string, todo, 1);
      }

      const orders = model.read().columns[0]?.cards.map((c) => c.order) ?? [];
      expect(new Set(orders).size, 'distinct orders').toBe(3);
      expect(
        orders.every((o, i) => i === 0 || o > (orders[i - 1] as number)),
        'ascending',
      ).toBe(true);
    });

    it('when card fields are updated then only valid values are stored', () => {
      const todo = model.read().columns[0]?.id as string;
      const card = model.addCard(todo, 'A') as string;

      model.updateCard(card, {
        title: 'Renamed',
        assignee: '  Alice  ',
        due: '2026-11-31',
        points: 5,
        labels: ['red', 'blue', 'constructor' as never],
      });

      expect(model.card(card), 'card').toMatchObject({
        title: 'Renamed',
        assignee: 'Alice',
        due: null,
        points: 5,
        labels: ['red', 'blue'],
      });
    });

    it('when labels change then removed ones go and new ones come', () => {
      const todo = model.read().columns[0]?.id as string;
      const card = model.addCard(todo, 'A') as string;
      model.updateCard(card, { labels: ['red', 'green'], due: '2026-12-01' });

      model.updateCard(card, { labels: ['green', 'purple'], assignee: null, points: null });

      expect(model.card(card)?.labels, 'labels').toEqual(['green', 'purple']);
      expect(model.card(card)?.due, 'due kept').toBe('2026-12-01');
    });

    it('when a card is deleted then it is gone', () => {
      const todo = model.read().columns[0]?.id as string;
      const card = model.addCard(todo, 'A') as string;

      model.deleteCard(card);

      expect(model.card(card), 'gone').toBeUndefined();
    });

    it('when a card is moved out then the new block and the removal are one undo step', () => {
      const todo = model.read().columns[0]?.id as string;
      const card = model.addCard(todo, 'Ship it') as string;

      const sticky = model.moveCardOut(card, (c) =>
        board.addBlock({ type: STICKY_TYPE, x: 0, y: 0, w: 10, h: 10, text: c.title }),
      ) as string;

      expect(board.textOf(sticky), 'sticky text').toBe('Ship it');
      expect(model.card(card), 'card gone').toBeUndefined();
      history.undo();
      expect(board.hasBlock(sticky), 'sticky undone').toBe(false);
      expect(model.card(card)?.title, 'card back').toBe('Ship it');
    });

    it('when the card limit is reached then no card is added', () => {
      const todo = model.read().columns[0]?.id as string;
      for (let i = 0; i < KANBAN_LIMITS.maxCards; i++) {
        model.addCard(todo, `c${i}`);
      }

      expect(model.addCard(todo, 'one too many'), 'refused').toBeUndefined();
    });
  });

  describe('undo', () => {
    it('when a move is undone then the card is back where it was', () => {
      const [todo, doing] = model.read().columns.map((c) => c.id) as [string, string];
      const a = model.addCard(todo, 'A') as string;

      model.moveCard(a, doing, 0);
      history.undo();

      expect(titles()[0], 'back in to do').toEqual(['To do', 'A']);
    });

    it('when each edit is undone then they come back one by one', () => {
      const todo = model.read().columns[0]?.id as string;
      const a = model.addCard(todo, 'A') as string;
      model.updateCard(a, { title: 'B' });

      history.undo();
      expect(model.card(a)?.title, 'rename undone').toBe('A');
      history.undo();
      expect(model.card(a), 'add undone').toBeUndefined();
    });
  });

  describe('concurrent edits', () => {
    function peer(): BoardDoc {
      const remote = new BoardDoc(new Y.Doc(), false);
      Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(board.doc));
      return remote;
    }
    function sync(a: BoardDoc, b: BoardDoc): void {
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    }

    it('when two people move the same card at once then it exists exactly once', () => {
      const [todo, doing, done] = model.read().columns.map((c) => c.id) as [string, string, string];
      const card = model.addCard(todo, 'A') as string;
      const remote = peer();
      const other = new KanbanModel(remote, id);

      model.moveCard(card, doing, 0);
      other.moveCard(card, done, 0);
      sync(board, remote);

      const everywhere = model.read().columns.flatMap((c) => c.cards.map((x) => x.id));
      expect(everywhere, 'once').toEqual([card]);
      expect(other.read(), 'same on both sides').toEqual(model.read());
      remote.destroy();
    });

    it('when one person moves a card while another renames it then both changes survive', () => {
      const [todo, doing] = model.read().columns.map((c) => c.id) as [string, string];
      const card = model.addCard(todo, 'A') as string;
      const remote = peer();

      model.moveCard(card, doing, 0);
      new KanbanModel(remote, id).updateCard(card, { title: 'Renamed', labels: ['red'] });
      sync(board, remote);

      expect(model.card(card), 'merged').toMatchObject({
        column: doing,
        title: 'Renamed',
        labels: ['red'],
      });
      remote.destroy();
    });

    it('when a column is deleted while someone moves a card into it then the card is kept', () => {
      const [todo, doing] = model.read().columns.map((c) => c.id) as [string, string];
      const card = model.addCard(todo, 'A') as string;
      const remote = peer();

      model.deleteColumn(doing);
      new KanbanModel(remote, id).moveCard(card, doing, 0);
      sync(board, remote);

      expect(
        model.read().columns[0]?.cards.map((c) => c.title),
        'in the first column',
      ).toEqual(['A']);
      remote.destroy();
    });
  });

  describe('reading foreign data', () => {
    it('when the props hold junk then only valid columns and cards are shown', () => {
      const props = new Y.Map<unknown>();
      const doc = new Y.Doc();
      doc.getMap('root').set('props', props);
      const columns = new Y.Map<unknown>();
      const cards = new Y.Map<unknown>();
      props.set('title', 42);
      props.set('columns', columns);
      props.set('cards', cards);
      const col = new Y.Map<unknown>();
      col.set('title', 'Ok');
      columns.set('11111111-1111-4111-8111-111111111111', col);
      columns.set('__proto__', new Y.Map<unknown>());
      columns.set('22222222-2222-4222-8222-222222222222', 'not a map');
      const card = new Y.Map<unknown>();
      card.set('title', 'x'.repeat(500));
      card.set('assignee', 7);
      card.set('due', 'tomorrow');
      card.set('points', -1);
      card.set('labels', ['red']);
      cards.set('33333333-3333-4333-8333-333333333333', card);

      const state = readKanban(props);

      expect(state.title, 'title').toBe('');
      expect(
        state.columns.map((c) => c.title),
        'columns',
      ).toEqual(['Ok']);
      expect(state.columns[0]?.cards[0], 'card').toMatchObject({
        title: 'x'.repeat(KANBAN_LIMITS.maxTitle),
        assignee: null,
        due: null,
        points: null,
        labels: [],
      });
    });

    it('when there are no props then the kanban is empty', () => {
      expect(readKanban(undefined), 'empty').toEqual({ title: '', columns: [] });
    });
  });

  describe('file form', () => {
    it('when a kanban goes to the file form and back then it is the same', () => {
      const todo = model.read().columns[0]?.id as string;
      const card = model.addCard(todo, 'A') as string;
      model.updateCard(card, { labels: ['red'], points: 3, due: '2026-12-24', assignee: 'Bob' });

      const file = kanbanPropsToFile(model.props());
      const copy = new BoardDoc();
      const copyId = copy.addBlock({
        type: KANBAN_TYPE,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        props: kanbanPropsToY(file),
      });

      expect(new KanbanModel(copy, copyId).read(), 'round trip').toEqual(model.read());
      copy.destroy();
    });
  });

  describe('helpers', () => {
    it('when an order between neighbours is asked then it lies between them', () => {
      expect(orderBetween(undefined, undefined), 'empty').toBe(1);
      expect(orderBetween(undefined, 3), 'before').toBe(2);
      expect(orderBetween(3, undefined), 'after').toBe(4);
      expect(orderBetween(1, 2), 'between').toBe(1.5);
    });

    it('when dates and labels are checked then only real ones pass', () => {
      expect(isValidDueDate('2026-02-28'), 'real').toBe(true);
      expect(isValidDueDate('2026-02-30'), 'no such day').toBe(false);
      expect(isValidDueDate(20261201), 'number').toBe(false);
      expect(isKanbanLabel('green'), 'label').toBe(true);
      expect(isKanbanLabel('toString'), 'inherited key').toBe(false);
      expect(labelColor('blue'), 'colour').toBe('#3b82f6');
    });
  });
});
