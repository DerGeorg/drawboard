import * as Y from 'yjs';

import {
  KANBAN_LIMITS,
  KANBAN_TYPE,
  KanbanModel,
  StoryCardInput,
  newKanbanProps,
  STICKY_TYPE,
  STORY_TYPE,
  StoryModel,
  newStoryProps,
  readStory,
  Point,
} from '@apps/drawboard-engine';
import { storyFromCard } from './blocks/kanban-story';
import { EstimateSource } from './blocks/story';
import { TestEngine, createTestEngine } from './testing/helpers';

/** Story cards dragged into a kanban column become cards (Miro-like: no data lost). */
describe('story cards dragged into a kanban', () => {
  let t: TestEngine;
  let kanban: string;
  let model: KanbanModel;
  let notices: string[];
  let open: Set<string>;

  const estimates: EstimateSource = {
    isOpen: (id) => open.has(id),
    onChange: () => () => undefined,
  };

  function setUp(readOnly = false): void {
    open = new Set();
    t = createTestEngine({ readOnly, services: { estimates } });
    notices = [];
    t.engine.clipboardNotice.on((m) => notices.push(m));
    kanban = t.board.addBlock({
      type: KANBAN_TYPE,
      x: 0,
      y: 0,
      w: 700,
      h: 400,
      props: newKanbanProps('Sprint', ['To do', 'Doing']),
    });
    model = new KanbanModel(t.board, kanban);
    layout();
  }
  afterEach(() => t.destroy());

  const root = (): HTMLElement =>
    t.engine.blockElement(kanban)?.querySelector('.be-kanban') as HTMLElement;
  const column = (i: number): HTMLElement =>
    root().querySelectorAll<HTMLElement>('[data-column-id]')[i] as HTMLElement;
  const columnIds = (): string[] => model.read().columns.map((c) => c.id);
  const cardTitles = (i: number): string[] =>
    model.read().columns[i]?.cards.map((c) => c.title) ?? [];

  function rect(el: Element, left: number, top: number, width: number, height: number): void {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
  }
  /** jsdom has no layout: columns 220 wide from x = 10, cards 40 high from y = 80 (world = screen). */
  function layout(): void {
    const origin = t.at(0, 0).screen;
    const r = (el: Element, l: number, tp: number, w: number, h: number): void =>
      rect(el, origin.x + l, origin.y + tp, w, h);
    r(root(), 0, 0, 700, 400);
    root()
      .querySelectorAll('[data-column-id]')
      .forEach((col, i) => {
        r(col, 10 + i * 230, 40, 220, 340);
        col
          .querySelectorAll('[data-card-id]')
          .forEach((card, j) => r(card, 16 + i * 230, 80 + j * 50, 208, 40));
      });
  }

  function story(x: number, y: number, title: string, estimate: string | null = null): string {
    const id = t.board.addBlock({
      type: STORY_TYPE,
      x,
      y,
      w: 300,
      h: 220,
      props: newStoryProps(),
      text: title,
    });
    const m = new StoryModel(t.board, id);
    m.setDescription(`About ${title} <b>bold</b>`);
    m.addCriterion('First');
    m.setEstimate(estimate);
    return id;
  }

  /** Presses on the story, drags it so that the pointer ends at `to`, optionally pausing. */
  function dragTo(id: string, to: Point, release = true): void {
    const b = t.board.getBlock(id);
    const from = { x: (b?.x ?? 0) + 10, y: (b?.y ?? 0) + 10 };
    t.engine.pointerDown(t.at(from.x, from.y));
    t.engine.pointerMove(t.at((from.x + to.x) / 2, (from.y + to.y) / 2));
    t.engine.pointerMove(t.at(to.x, to.y));
    if (release) {
      t.engine.pointerUp(t.at(to.x, to.y, { buttons: 0 }));
    }
  }

  describe('highlight', () => {
    it('when a story is dragged over a column then the column and the insert position show', () => {
      setUp();
      model.addCard(columnIds()[1] as string, 'B');
      model.addCard(columnIds()[1] as string, 'C');
      layout();
      const s = story(10, 600, 'Checkout');

      dragTo(s, { x: 260, y: 145 }, false);

      expect(column(1).dataset['drop'], 'second column outlined').toBe('story');
      expect(column(1).style.outline, 'uses the theme variable').toContain('--be-selection');
      expect(column(0).dataset['drop'], 'first not').toBeUndefined();
      const marker = root().querySelector('.be-kb-drop');
      expect(marker?.nextElementSibling?.getAttribute('data-card-id'), 'before the card C').toBe(
        model.read().columns[1]?.cards[1]?.id,
      );

      t.engine.pointerMove(t.at(800, 500));
      expect(column(1).dataset['drop'], 'gone outside').toBeUndefined();
      expect(root().querySelector('.be-kb-drop'), 'marker gone').toBeNull();
    });

    it('when the drag is cancelled then the highlight is removed and nothing is taken', () => {
      setUp();
      const s = story(10, 600, 'Checkout');

      dragTo(s, { x: 20, y: 120 }, false);
      expect(column(0).dataset['drop'], 'shown').toBe('story');
      t.key('Escape');

      expect(column(0).dataset['drop'], 'cleared').toBeUndefined();
      expect(t.board.hasBlock(s), 'story kept').toBe(true);
      expect(cardTitles(0), 'no card').toEqual([]);
    });
  });

  describe('drop', () => {
    it('when a story is dropped on a column then a card with all details takes its place', () => {
      setUp();
      model.addCard(columnIds()[1] as string, 'B');
      model.addCard(columnIds()[1] as string, 'C');
      layout();
      const s = story(10, 600, 'Checkout', '5');

      dragTo(s, { x: 260, y: 145 });

      expect(t.board.hasBlock(s), 'story deleted').toBe(false);
      expect(cardTitles(1), 'between B and C').toEqual(['B', 'Checkout', 'C']);
      expect(model.read().columns[1]?.cards[1], 'details').toMatchObject({
        description: 'About Checkout <b>bold</b>',
        criteria: [{ text: 'First', done: false }],
        estimate: '5',
        points: 5,
      });
      expect(root().querySelector('.be-kb-drop'), 'no marker left').toBeNull();
      expect(t.engine.selection.list(), 'the kanban is selected').toEqual([kanban]);
    });

    it('when the drop is undone then story and card are restored in one step', () => {
      setUp();
      const s = story(10, 600, 'Checkout', '8');
      t.engine.stopCapturing();

      dragTo(s, { x: 20, y: 120 });
      expect(cardTitles(0), 'card in the column').toEqual(['Checkout']);

      t.engine.undo();
      expect(cardTitles(0), 'card gone').toEqual([]);
      expect(t.board.hasBlock(s), 'story back').toBe(true);
      expect(readStory(t.board, s), 'with its details').toMatchObject({
        title: 'Checkout',
        description: 'About Checkout <b>bold</b>',
        criteria: [{ text: 'First' }],
        estimate: '8',
      });

      t.engine.redo();
      expect(cardTitles(0), 'redo').toEqual(['Checkout']);
      expect(t.board.hasBlock(s), 'story deleted again').toBe(false);
    });

    it('when several stories are dropped then they land top to bottom in the order of their position', () => {
      setUp();
      model.addCard(columnIds()[0] as string, 'Existing');
      layout();
      const low = story(10, 700, 'Low');
      const high = story(10, 500, 'High');
      const mid = story(400, 600, 'Mid');
      t.engine.selection.set([low, high, mid]);

      dragTo(low, { x: 20, y: 160 });

      expect(cardTitles(0), 'after the existing card').toEqual(['Existing', 'High', 'Mid', 'Low']);
      expect(
        t.board.blocks().filter((b) => b.type === STORY_TYPE),
        'all stories gone',
      ).toEqual([]);

      t.engine.undo();
      expect(cardTitles(0), 'one undo step').toEqual(['Existing']);
      expect(
        t.board.blocks().filter((b) => b.type === STORY_TYPE),
        'stories are back',
      ).toHaveLength(3);
    });

    it('when the pointer is above all cards then the stories go to the top', () => {
      setUp();
      model.addCard(columnIds()[0] as string, 'Existing');
      layout();
      const s = story(10, 600, 'First');

      dragTo(s, { x: 20, y: 60 });

      expect(cardTitles(0), 'on top').toEqual(['First', 'Existing']);
    });

    it('when the estimate is not a number then it survives and the card has no points', () => {
      setUp();
      const s = story(10, 600, 'Unclear', '?');

      dragTo(s, { x: 20, y: 120 });

      expect(model.read().columns[0]?.cards[0], 'card').toMatchObject({
        estimate: '?',
        points: null,
      });
    });

    it('when two kanbans overlap then the one on top takes the story', () => {
      setUp();
      const other = t.board.addBlock({
        type: KANBAN_TYPE,
        x: 0,
        y: 0,
        w: 700,
        h: 400,
        props: newKanbanProps('Top', ['Only']),
      });
      layout();
      const otherRoot = t.engine.blockElement(other)?.querySelector('.be-kanban') as HTMLElement;
      const origin = t.at(0, 0).screen;
      rect(otherRoot, origin.x, origin.y, 700, 400);
      otherRoot
        .querySelectorAll('[data-column-id]')
        .forEach((col) => rect(col, origin.x + 10, origin.y + 40, 220, 340));
      const s = story(10, 600, 'S');

      dragTo(s, { x: 20, y: 120 });

      expect(new KanbanModel(t.board, other).read().columns[0]?.cards, 'top kanban').toHaveLength(
        1,
      );
      expect(cardTitles(0), 'lower kanban').toEqual([]);
    });
  });

  describe('round trip', () => {
    it('when a card goes back to a story card then description, criteria and estimate return', () => {
      setUp();
      const s = story(10, 600, 'Unclear', '?');
      dragTo(s, { x: 20, y: 120 });
      const card = model.read().columns[0]?.cards[0];

      const id = model.moveCardOut(card?.id as string, (c) =>
        t.board.addBlock(storyFromCard(c, { x: 500, y: 700 })),
      ) as string;

      expect(readStory(t.board, id), 'same story').toEqual({
        title: 'Unclear',
        description: 'About Unclear <b>bold</b>',
        criteria: [{ id: expect.any(String), text: 'First', done: false }],
        estimate: '?',
        pokerRoundId: null,
      });
      expect(cardTitles(0), 'card gone').toEqual([]);
    });

    it('when the points were changed in between then the story gets the new points', () => {
      setUp();
      const s = story(10, 600, 'Sized', '5');
      dragTo(s, { x: 20, y: 120 });
      const card = model.read().columns[0]?.cards[0];
      model.updateCard(card?.id as string, { points: 13 });

      const id = model.moveCardOut(card?.id as string, (c) =>
        t.board.addBlock(storyFromCard(c, { x: 500, y: 700 })),
      ) as string;

      expect(readStory(t.board, id).estimate, 'new points win').toBe('13');
    });
  });

  describe('not allowed', () => {
    it('when a poker round is open then there is no highlight, a notice, and nothing is taken', () => {
      setUp();
      const s = story(10, 600, 'Busy');
      const round = '77777777-7777-4777-8777-777777777777';
      new StoryModel(t.board, s).setPokerRound(round);
      open.add(s);

      dragTo(s, { x: 20, y: 120 }, false);
      expect(column(0).dataset['drop'], 'no highlight').toBeUndefined();
      t.engine.pointerUp(t.at(20, 120, { buttons: 0 }));

      expect(notices, 'notice').toEqual(['Finish or cancel the estimation first']);
      expect(t.board.hasBlock(s), 'story stays').toBe(true);
      expect(cardTitles(0), 'no card').toEqual([]);
    });

    it('when the server lists the round but the card marker was cleared then the drop is still blocked', () => {
      setUp();
      const s = story(10, 600, 'Busy');
      open.add(s); // pokerRoundId is null: any editor can clear it

      dragTo(s, { x: 20, y: 120 });

      expect(notices, 'notice').toEqual(['Finish or cancel the estimation first']);
      expect(t.board.hasBlock(s), 'story stays').toBe(true);
    });

    it('when the descriptions would pass the byte budget of the kanban then nothing is taken and a notice says so', () => {
      setUp();
      const col = columnIds()[0] as string;
      const big = (i: number, chars: number): StoryCardInput => ({
        title: `Big${i}`,
        description: 'x'.repeat(chars),
        criteria: [],
        estimate: null,
        points: null,
      });
      // 25 x 10 000 + 9 000 bytes: 3 144 of the budget are left
      model.addStoryCards(col, 0, [
        ...Array.from({ length: 25 }, (_, i) => big(i, 10_000)),
        big(25, 9_000),
      ]);
      layout();
      const s = story(10, 600, 'More');
      new StoryModel(t.board, s).setDescription('y'.repeat(5_000));

      dragTo(s, { x: 20, y: 120 });

      expect(notices[0], 'notice').toContain('cannot hold that much description text');
      expect(t.board.hasBlock(s), 'story stays').toBe(true);
      expect(cardTitles(0), 'no new card').toHaveLength(26);
    });

    it('when a block lies above the kanban at the drop point then the kanban takes nothing', () => {
      setUp();
      const s = story(10, 600, 'Hidden');
      t.board.addBlock({ type: STICKY_TYPE, x: 0, y: 40, w: 300, h: 300, text: 'cover' });

      dragTo(s, { x: 20, y: 120 }, false);
      expect(column(0).dataset['drop'], 'no highlight').toBeUndefined();
      t.engine.pointerUp(t.at(20, 120, { buttons: 0 }));

      expect(t.board.hasBlock(s), 'story stays').toBe(true);
      expect(cardTitles(0), 'no card').toEqual([]);
    });

    it('when the round marker is stale then the story may go in', () => {
      setUp();
      const s = story(10, 600, 'Stale');
      new StoryModel(t.board, s).setPokerRound('77777777-7777-4777-8777-777777777777');
      // the server does not list the round as open

      dragTo(s, { x: 20, y: 120 });

      expect(notices, 'no notice').toEqual([]);
      expect(cardTitles(0), 'taken').toEqual(['Stale']);
    });

    it('when only one of several stories is estimating then none is taken', () => {
      setUp();
      const a = story(10, 600, 'A');
      const b = story(400, 600, 'B');
      new StoryModel(t.board, b).setPokerRound('77777777-7777-4777-8777-777777777777');
      open.add(b);
      t.engine.selection.set([a, b]);

      dragTo(a, { x: 20, y: 120 });

      expect(notices, 'notice').toEqual(['Finish or cancel the estimation first']);
      expect(cardTitles(0), 'no card').toEqual([]);
      expect(t.board.hasBlock(a) && t.board.hasBlock(b), 'both stay').toBe(true);
    });

    it('when the board is read-only then nothing happens', () => {
      setUp(true);
      const s = story(10, 600, 'Viewer');

      dragTo(s, { x: 20, y: 120 });

      expect(t.board.hasBlock(s), 'story stays').toBe(true);
      expect(t.board.getBlock(s)?.y, 'not even moved').toBe(600);
      expect(cardTitles(0), 'no card').toEqual([]);
      expect(notices, 'no notice').toEqual([]);
    });

    it('when the kanban cannot take that many cards then nothing is taken and a notice says so', () => {
      setUp();
      const col = columnIds()[0] as string;
      t.board.transact(() => {
        const cards = model.props()?.get('cards') as Y.Map<unknown>;
        for (let i = 0; i < KANBAN_LIMITS.maxCards - 1; i++) {
          const m = new Y.Map<unknown>();
          m.set('column', col);
          m.set('order', i);
          cards.set(crypto.randomUUID(), m);
        }
      });
      layout();
      const a = story(10, 600, 'A');
      const b = story(400, 600, 'B');
      t.engine.selection.set([a, b]);

      dragTo(a, { x: 20, y: 120 });

      expect(notices, 'notice').toEqual(['This kanban has room for 1 more cards']);
      expect(t.board.hasBlock(a) && t.board.hasBlock(b), 'both stay').toBe(true);
    });

    it('when a story is mixed with another block then everything is only moved', () => {
      setUp();
      const s = story(10, 600, 'S');
      const note = t.board.addBlock({ type: STICKY_TYPE, x: 400, y: 600, w: 100, h: 100 });
      t.engine.selection.set([s, note]);

      dragTo(s, { x: 20, y: 120 }, false);
      expect(column(0).dataset['drop'], 'no highlight').toBeUndefined();
      t.engine.pointerUp(t.at(20, 120, { buttons: 0 }));

      expect(t.board.hasBlock(s) && t.board.hasBlock(note), 'both stay').toBe(true);
      expect(cardTitles(0), 'no card').toEqual([]);
      expect(t.board.getBlock(s)?.y, 'moved').toBeLessThan(600);
    });

    it('when a sticky note is dragged over a kanban then it is only moved', () => {
      setUp();
      const note = t.board.addBlock({ type: STICKY_TYPE, x: 10, y: 600, w: 100, h: 100 });

      dragTo(note, { x: 20, y: 120 });

      expect(t.board.hasBlock(note), 'sticky stays').toBe(true);
      expect(cardTitles(0), 'no card').toEqual([]);
    });

    it('when the story is dropped outside the kanban then it is only moved', () => {
      setUp();
      const s = story(10, 600, 'S');

      dragTo(s, { x: 900, y: 500 });

      expect(t.board.hasBlock(s), 'story stays').toBe(true);
      expect(cardTitles(0), 'no card').toEqual([]);
      expect(notices, 'no notice').toEqual([]);
    });
  });
});
