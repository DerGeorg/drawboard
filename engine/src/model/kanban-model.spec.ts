import * as Y from 'yjs';

import { History } from '../testing/undo.js';
import { BoardDoc } from './board-doc.js';
import {
  KANBAN_LIMITS,
  KANBAN_TYPE,
  KanbanModel,
  StoryCardInput,
  isKanbanLabel,
  isValidDueDate,
  kanbanPropsToFile,
  kanbanPropsToY,
  labelColor,
  newKanbanProps,
  orderBetween,
  KanbanFileProps,
  KanbanLabel,
  detailBytes,
  estimateOfCard,
  utf8Length,
  pointsOfEstimate,
  readKanban,
} from './kanban-model.js';
import { STORY_LIMITS } from './story-model.js';
import { STICKY_TYPE } from './block-types.js';

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

  describe('story details', () => {
    const C1 = '55555555-5555-4555-8555-555555555555';
    const C2 = '66666666-6666-4666-8666-666666666666';
    const story = (over: Partial<StoryCardInput> = {}): StoryCardInput => ({
      title: 'Checkout',
      description: 'Pay with <b>card</b>',
      criteria: [{ id: C1, text: 'Card accepted', done: true }],
      estimate: '5',
      points: 5,
      ...over,
    });
    const todo = (): string => model.read().columns[0]?.id as string;

    it('when a card has no details then description, criteria and estimate are empty', () => {
      const card = model.addCard(todo(), 'Plain') as string;

      expect(model.card(card), 'defaults').toMatchObject({
        description: '',
        criteria: [],
        estimate: null,
      });
    });

    it('when story cards are added then they keep their details in the order given', () => {
      const first = model.addCard(todo(), 'First') as string;
      const last = model.addCard(todo(), 'Last') as string;

      const ids = model.addStoryCards(todo(), 1, [
        story({ title: 'A' }),
        story({ title: 'B', estimate: '?', points: null, criteria: [] }),
      ]) as string[];

      expect(titles()[0], 'between').toEqual(['To do', 'First', 'A', 'B', 'Last']);
      expect(model.card(ids[0] as string), 'details').toMatchObject({
        description: 'Pay with <b>card</b>',
        criteria: [{ id: C1, text: 'Card accepted', done: true }],
        estimate: '5',
        points: 5,
      });
      expect(model.card(ids[1] as string), 'non-numeric estimate kept').toMatchObject({
        estimate: '?',
        points: null,
      });
      expect(
        [first, last].every((c) => model.card(c)),
        'others stay',
      ).toBe(true);
    });

    it('when story cards are added in one go then there is one undo step', () => {
      model.addStoryCards(todo(), 0, [story({ title: 'A' }), story({ title: 'B' })]);

      history.undo();

      expect(titles()[0], 'both gone').toEqual(['To do']);
    });

    it('when the kanban is full then story cards are refused and nothing is written', () => {
      const cards = new Y.Map<unknown>();
      board.transact(() => {
        for (let i = 0; i < KANBAN_LIMITS.maxCards - 1; i++) {
          const m = new Y.Map<unknown>();
          m.set('column', todo());
          m.set('order', i);
          cards.set(crypto.randomUUID(), m);
        }
        (model.props() as Y.Map<unknown>).set('cards', cards);
      });

      expect(model.addStoryCards(todo(), 0, [story(), story()]), 'too many').toBeUndefined();
      expect(model.addStoryCards('nope', 0, [story()]), 'no such column').toBeUndefined();
      expect(model.addStoryCards(todo(), 0, [story()]), 'one fits').toHaveLength(1);
      expect(model.addStoryCards(todo(), 0, []), 'nothing to add').toBeUndefined();
    });

    it('when story cards crowd a spot then the order stays consistent', () => {
      const a = model.addCard(todo(), 'A') as string;
      const b = model.addCard(todo(), 'B') as string;
      for (let i = 0; i < 60; i++) {
        model.addStoryCards(todo(), 1, [story({ title: `S${i}` })]);
      }

      const names = model.read().columns[0]?.cards.map((c) => c.title) ?? [];
      expect(names[0], 'first').toBe('A');
      expect(names.at(-1), 'last').toBe('B');
      expect(names, 'all there, newest first among the new').toHaveLength(62);
      expect(names[1], 'newest at index 1').toBe('S59');
      expect(
        [a, b].every((c) => model.card(c)),
        'originals',
      ).toBe(true);
    });

    it('when details are cut to the limits then too long or malformed ones do not get in', () => {
      const [id] = model.addStoryCards(todo(), 0, [
        story({
          title: 'x'.repeat(300),
          description: 'd'.repeat(STORY_LIMITS.maxDescription + 5),
          estimate: 'way too long',
          points: 5000,
          criteria: [
            { id: 'not-a-uuid', text: 'bad id', done: false },
            { id: C1, text: 't'.repeat(STORY_LIMITS.maxCriterion + 5), done: true },
            { id: C1, text: 'same id twice', done: false },
          ],
        }),
      ]) as string[];

      const card = model.card(id as string);
      expect(card?.title.length, 'title').toBe(KANBAN_LIMITS.maxTitle);
      expect(card?.description.length, 'description').toBe(STORY_LIMITS.maxDescription);
      expect(card?.estimate, 'estimate').toBeNull();
      expect(card?.points, 'points').toBeNull();
      expect(card?.criteria, 'criteria').toEqual([
        { id: C1, text: 't'.repeat(STORY_LIMITS.maxCriterion), done: true },
      ]);
    });

    it('when a card is updated then description and criteria change by id', () => {
      const [id] = model.addStoryCards(todo(), 0, [
        story({ criteria: [{ id: C1, text: 'One', done: false }] }),
      ]) as string[];
      const card = id as string;

      model.updateCard(card, {
        description: 'New',
        criteria: [
          { id: C1, text: 'One', done: true },
          { id: C2, text: 'Two', done: false },
        ],
      });
      expect(model.card(card), 'edited and added').toMatchObject({
        description: 'New',
        criteria: [
          { id: C1, text: 'One', done: true },
          { id: C2, text: 'Two', done: false },
        ],
      });

      model.updateCard(card, { criteria: [{ id: C2, text: 'Two', done: true }] });
      expect(model.card(card)?.criteria, 'removed').toEqual([{ id: C2, text: 'Two', done: true }]);

      model.updateCard(card, { description: '', criteria: [] });
      expect(model.card(card), 'emptied').toMatchObject({ description: '', criteria: [] });
    });

    it('when the props hold junk in the new fields then they read as empty', () => {
      const [id] = model.addStoryCards(todo(), 0, [story()]) as string[];
      const m = (model.props()?.get('cards') as Y.Map<Y.Map<unknown>>).get(id as string);
      m?.set('description', 42);
      m?.set('criteria', 'x');
      m?.set('estimate', { a: 1 });

      expect(model.card(id as string), 'defaults').toMatchObject({
        description: '',
        criteria: [],
        estimate: null,
      });
    });

    it('when the details go to the file form and back then nothing is lost', () => {
      model.addStoryCards(todo(), 0, [story()]);

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

      expect(file.cards[0], 'in the file').toMatchObject({ description: 'Pay with <b>card</b>' });
      expect(new KanbanModel(copy, copyId).read(), 'same').toEqual(model.read());
      copy.destroy();
    });

    it('when estimates and points meet then the estimate wins until the points change', () => {
      expect(pointsOfEstimate('8'), 'number').toBe(8);
      expect(pointsOfEstimate('0.5'), 'decimal').toBe(0.5);
      expect(pointsOfEstimate('?'), 'no number').toBeNull();
      expect(pointsOfEstimate('1000'), 'past the limit').toBeNull();
      expect(pointsOfEstimate('0x10'), 'no hex').toBeNull();
      expect(pointsOfEstimate(null), 'none').toBeNull();
      expect(estimateOfCard({ estimate: '?', points: null }), 'kept').toBe('?');
      expect(estimateOfCard({ estimate: '1000', points: null }), 'kept past the limit').toBe(
        '1000',
      );
      expect(estimateOfCard({ estimate: '5', points: 5 }), 'same').toBe('5');
      expect(estimateOfCard({ estimate: '5', points: 8 }), 'points changed').toBe('8');
      expect(estimateOfCard({ estimate: '5', points: null }), 'points cleared').toBeNull();
      expect(estimateOfCard({ estimate: '?', points: 3 }), 'points set').toBe('3');
      expect(estimateOfCard({ estimate: null, points: null }), 'none').toBeNull();
    });
  });

  describe('byte budget (S2.5: one UPDATE frame is 1 MiB)', () => {
    const cjk = (n: number): string => '漢'.repeat(n);
    const C = (i: number): string => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;

    /** A kanban at every limit: 20 columns, 500 cards with CJK texts, the detail budget used up. */
    function maximal(): KanbanFileProps {
      const columns = Array.from({ length: KANBAN_LIMITS.maxColumns }, (_, i) => ({
        id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
        title: cjk(KANBAN_LIMITS.maxColumnTitle),
        order: i + 1,
      }));
      const perCard = Math.floor(KANBAN_LIMITS.maxDetailBytes / 3 / KANBAN_LIMITS.maxCards);
      const cards = Array.from({ length: KANBAN_LIMITS.maxCards }, (_, i) => ({
        id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
        column: (columns[i % columns.length] as { id: string }).id,
        order: i + 1,
        title: cjk(KANBAN_LIMITS.maxTitle),
        assignee: cjk(KANBAN_LIMITS.maxAssignee),
        due: '2026-12-24',
        labels: ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'] as KanbanLabel[],
        points: 999,
        description: cjk(Math.floor(perCard / 2)),
        criteria: [{ id: C(i), text: cjk(Math.floor(perCard / 2) - 1), done: true }],
        estimate: '8',
      }));
      return { title: cjk(KANBAN_LIMITS.maxTitle), columns, cards };
    }

    it('when a kanban is at every limit then its Yjs update stays well below 1 MiB', () => {
      const file = maximal();
      expect(
        file.cards.reduce((n, c) => n + detailBytes(c.description, c.criteria), 0),
        'the budget is used',
      ).toBeGreaterThan(KANBAN_LIMITS.maxDetailBytes * 0.95);
      const maximalBoard = new BoardDoc();
      maximalBoard.addBlock({
        type: KANBAN_TYPE,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        props: kanbanPropsToY(file),
      });

      const bytes = Y.encodeStateAsUpdate(maximalBoard.doc).byteLength;

      expect(bytes, `update of ${bytes} bytes`).toBeLessThan(1024 * 1024);
      maximalBoard.destroy();
    });

    it('when a maximal drop fills the budget then its update is below 1 MiB, one more byte is refused', () => {
      const small = new BoardDoc();
      const kid = small.addBlock({
        type: KANBAN_TYPE,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        props: newKanbanProps('K', ['A']),
      });
      const m = new KanbanModel(small, kid);
      const col = m.read().columns[0]?.id as string;
      const updates: number[] = [];
      small.doc.on('update', (u: Uint8Array) => updates.push(u.byteLength));
      const chars = STORY_LIMITS.maxDescription;
      const stories = Array.from({ length: 8 }, (_, i) => ({
        title: cjk(KANBAN_LIMITS.maxTitle),
        description: cjk(chars),
        criteria: [{ id: C(i), text: cjk(STORY_LIMITS.maxCriterion), done: false }],
        estimate: '8',
        points: 8,
      }));

      const ids = m.addStoryCards(col, 0, stories.slice(0, 8));

      // 8 x (10 000 + 500) CJK characters = 252 000 bytes: fits the budget of 262 144
      expect(ids, 'fits').toHaveLength(8);
      expect(Math.max(...updates), 'one update').toBeLessThan(1024 * 1024);
      expect(m.addStoryCards(col, 0, stories.slice(0, 1)), 'a ninth does not fit').toBeUndefined();
      small.destroy();
    });

    it('when a card update would pass the budget then it is refused and nothing is written', () => {
      const todo = model.read().columns[0]?.id as string;
      // 26 x 10 000 bytes: 2 144 bytes of the budget are left
      for (let i = 0; i < 26; i++) {
        const card = model.addCard(todo, `F${i}`) as string;
        expect(model.updateCard(card, { description: 'x'.repeat(10_000) }), 'fits').toBe(true);
      }
      const b = model.addCard(todo, 'B') as string;

      expect(
        model.updateCard(b, { title: 'B2', description: 'y'.repeat(3_000), criteria: [] }),
        'refused',
      ).toBe(false);
      expect(model.card(b), 'nothing written').toMatchObject({ title: 'B', description: '' });
      expect(model.updateCard(b, { title: 'B3' }), 'a title never counts').toBe(true);
      expect(model.updateCard(b, { description: 'y'.repeat(2_000) }), 'what fits').toBe(true);
    });

    it('when a foreign document is over the budget then cards beyond it read without details', () => {
      const todo = model.read().columns[0]?.id as string;
      const ids = Array.from({ length: 10 }, (_, i) => model.addCard(todo, `C${i}`) as string);
      board.transact(() => {
        const cards = model.props()?.get('cards') as Y.Map<Y.Map<unknown>>;
        for (const id of ids) {
          cards.get(id)?.set('description', cjk(10_000)); // 30 000 bytes each
        }
      });

      const described = model.read().columns[0]?.cards.filter((c) => c.description !== '');
      expect(described, '8 x 30 000 fit, the other two are read empty').toHaveLength(8);
      const file = kanbanPropsToFile(model.props());
      expect(
        file.cards.reduce((n, c) => n + detailBytes(c.description, c.criteria), 0),
        'the export is within the budget again',
      ).toBeLessThanOrEqual(KANBAN_LIMITS.maxDetailBytes);
    });

    it('when texts are measured then bytes are UTF-8 bytes', () => {
      expect(utf8Length('abc'), 'ascii').toBe(3);
      expect(utf8Length('é'), 'two').toBe(2);
      expect(utf8Length('漢'), 'three').toBe(3);
      expect(utf8Length('😀'), 'four for a pair').toBe(4);
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
