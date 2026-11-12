import { KANBAN_LIMITS, KANBAN_TYPE, KanbanModel, newKanbanProps } from '../blocks/kanban-model';
import { STORY_TYPE, StoryModel, newStoryProps } from '../blocks/story-model';
import { BoardDoc } from '../model/board-doc';
import {
  BoardFile,
  ImportError,
  LIMITS,
  boardToFile,
  parseBoardFile,
  splitBoardFile,
  writeBoardFile,
} from './board-file';

const block = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'b1',
  type: 'core.sticky',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 1,
  parent: null,
  locked: false,
  props: { color: '#fde68a' },
  text: 'hello',
  ...overrides,
});

const file = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  title: 'T',
  blocks: [block()],
  connectors: [],
  strokes: [],
  ...overrides,
});

/** The message of the ImportError, or fails the test. */
function rejection(json: unknown): string {
  try {
    parseBoardFile(json);
  } catch (error) {
    expect(error, 'error type').toBeInstanceOf(ImportError);
    return (error as ImportError).message;
  }
  return 'NOT REJECTED';
}

describe('board file', () => {
  describe('parseBoardFile', () => {
    it('when the file is valid then a clean copy is returned', () => {
      const parsed = parseBoardFile(file({ extra: 'ignored' }));

      expect(parsed.title, 'title').toBe('T');
      expect(parsed.blocks[0]?.text, 'text').toBe('hello');
      expect(Object.keys(parsed).sort(), 'only known keys').toEqual([
        'blocks',
        'connectors',
        'schemaVersion',
        'strokes',
        'title',
      ]);
    });

    it('when the schema version is unknown then it is refused with a version message', () => {
      expect(rejection(file({ schemaVersion: 2 })), 'message').toContain('version 2');
      expect(rejection(file({ schemaVersion: undefined })), 'message').toContain('version');
    });

    it.each([
      ['an array', []],
      ['null', null],
      ['a string', 'x'],
    ])('when the top level is %s then it is refused', (_name, json) => {
      expect(rejection(json), 'message').toContain('not an object');
    });

    it('when a block has an unknown type then the file is refused', () => {
      expect(rejection(file({ blocks: [block({ type: 'acme.evil' })] })), 'message').toContain(
        'unknown type "acme.evil"',
      );
    });

    it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
      'when the block type is the Object.prototype member %s then the file is refused as an unknown type',
      (type) => {
        expect(rejection(file({ blocks: [block({ type })] })), 'message').toContain(
          `unknown type "${type}"`,
        );
      },
    );

    it.each([
      ['an infinite x (1e999)', { x: Infinity }],
      ['a NaN y', { y: Number.NaN }],
      ['a string width', { w: '100' }],
      ['a zero width', { w: 0 }],
      ['a huge coordinate', { x: LIMITS.maxCoordinate + 1 }],
      ['a bad id', { id: '../etc' }],
      ['a bad colour', { props: { color: 'red;background:url(x)' } }],
      ['a text that is not text', { text: 5 }],
      ['a text over 100000 characters', { text: 'x'.repeat(100_001) }],
      ['a locked flag that is not boolean', { locked: 'yes' }],
      ['props that are not an object', { props: 5 }],
    ])('when a block has %s then the file is refused', (_name, patch) => {
      expect(rejection(file({ blocks: [block(patch)] })), 'message').toContain(
        'not a valid Drawboard board',
      );
    });

    it('when block props break the rules of their type then the file is refused', () => {
      const shape = (props: object) => file({ blocks: [block({ type: 'core.shape', props })] });

      expect(rejection(shape({ kind: 'star' })), 'kind').toContain('rect, ellipse or diamond');
      expect(rejection(shape({ fill: 'javascript:1' })), 'fill').toContain('hex colour');
      expect(rejection(shape({ strokeWidth: 9999 })), 'stroke width').toContain('stroke width');
      expect(
        rejection(file({ blocks: [block({ type: 'core.text', props: { fontSize: 1 } })] })),
        'font size',
      ).toContain('font size');
      expect(parseBoardFile(shape({ kind: 'ellipse', fill: 'none' })).blocks.length, 'valid').toBe(
        1,
      );
    });

    it('when a file block is imported then only its file id is kept and a URL is refused', () => {
      const fileBlock = (props: object) =>
        file({ blocks: [block({ type: 'core.file', props, text: undefined })] });
      const id = '0192F5E0-7C1A-7B3E-8F00-2A1B3C4D5E6F';

      expect(
        parseBoardFile(fileBlock({ fileId: id, url: '/files/x?sig=secret' })).blocks[0]?.props,
        'only the lower-case id survives',
      ).toEqual({ fileId: id.toLowerCase() });
      expect(rejection(fileBlock({ fileId: '/files/x?sig=1' })), 'no URL as id').toContain(
        'file id',
      );
      expect(rejection(fileBlock({})), 'id required').toContain('file id');
    });

    it('when there are more than 20000 blocks then the file is refused', () => {
      const many = Array.from({ length: LIMITS.maxBlocks + 1 }, (_, i) => block({ id: `b${i}` }));

      expect(rejection(file({ blocks: many })), 'message').toContain('more than 20000 blocks');
    });

    it('when 20000 blocks are given then they are accepted', () => {
      const many = Array.from({ length: LIMITS.maxBlocks }, (_, i) => block({ id: `b${i}` }));

      expect(parseBoardFile(file({ blocks: many })).blocks.length, 'blocks').toBe(20_000);
    });

    it('when ids repeat or references dangle then the file is refused', () => {
      expect(rejection(file({ blocks: [block(), block()] })), 'duplicate').toContain('share an id');
      expect(rejection(file({ blocks: [block({ parent: 'nope' })] })), 'parent').toContain(
        'parent that does not exist',
      );
      const connector = {
        id: 'c1',
        from: { block: 'ghost', anchor: 'auto' },
        to: { x: 1, y: 2 },
      };
      expect(rejection(file({ connectors: [connector] })), 'connector').toContain(
        'block that does not exist',
      );
    });

    it('when parent links break the frame rules then the file is refused', () => {
      const frame = (id: string, parent: string | null = null): Record<string, unknown> =>
        block({ id, type: 'core.frame', props: { fill: '#ffffff' }, text: 'F', parent });
      const chain = Array.from({ length: 9 }, (_, i) =>
        frame(`f${i}`, i === 0 ? null : `f${i - 1}`),
      );

      expect(
        rejection(file({ blocks: [block({ id: 's' }), block({ id: 'c', parent: 's' })] })),
        'not a frame',
      ).toContain('parent that is not a frame');
      expect(rejection(file({ blocks: [frame('a', 'b'), frame('b', 'a')] })), 'cycle').toContain(
        'contain each other',
      );
      expect(rejection(file({ blocks: [frame('a', 'a')] })), 'own parent').toContain(
        'contain each other',
      );
      expect(rejection(file({ blocks: chain })), 'too deep').toContain('more than 8 frames deep');
      expect(
        parseBoardFile(file({ blocks: [...chain.slice(0, 8), block({ id: 'n', parent: 'f7' })] }))
          .blocks.length,
        'eight frames and a note inside: fine',
      ).toBe(9);
    });

    it('when a frame is imported then its fill and title are checked', () => {
      const frame = (props: Record<string, unknown>, text = 'Title'): Record<string, unknown> =>
        block({ type: 'core.frame', props, text });

      expect(
        parseBoardFile(file({ blocks: [frame({ fill: 'transparent' })] })).blocks[0]?.props,
        'transparent',
      ).toEqual({ fill: 'transparent' });
      expect(rejection(file({ blocks: [frame({ fill: 'url(x)' })] })), 'fill (S5.2)').toContain(
        'hex colour',
      );
      expect(rejection(file({ blocks: [frame({}, 'x'.repeat(201))] })), 'title').toContain(
        'at most 200',
      );
    });

    it('when a connector is valid then its ends and style are kept', () => {
      const parsed = parseBoardFile(
        file({
          connectors: [
            {
              id: 'c1',
              from: { block: 'b1', anchor: 'right' },
              to: { x: 5, y: 6 },
              style: { dashed: true },
              label: 'L',
            },
          ],
        }),
      );

      expect(parsed.connectors[0]?.to, 'free end').toEqual({ x: 5, y: 6 });
      expect(parsed.connectors[0]?.style, 'style with defaults').toEqual({
        color: '#334155',
        width: 2,
        arrow: true,
        dashed: true,
      });
    });

    it('when a connector end or style is broken then the file is refused', () => {
      const base = { id: 'c1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } };
      expect(
        rejection(file({ connectors: [{ ...base, from: { block: 'b1', anchor: 'middle' } }] })),
        'anchor',
      ).toContain('anchor');
      expect(
        rejection(file({ connectors: [{ ...base, from: { x: Infinity, y: 0 } }] })),
        'coordinate',
      ).toContain('finite');
      expect(
        rejection(file({ connectors: [{ ...base, style: { color: 'blue' } }] })),
        'colour',
      ).toContain('hex colour');
      expect(rejection(file({ connectors: [{ ...base, from: 5 }] })), 'end').toContain(
        'not an object',
      );
    });

    it('when strokes are broken then the file is refused, and good ones are kept', () => {
      const stroke = { id: 's1', points: [0, 0, 1, 5, 5, 1], style: { color: '#000', size: 3 } };

      expect(parseBoardFile(file({ strokes: [stroke] })).strokes[0]?.points.length, 'points').toBe(
        6,
      );
      expect(rejection(file({ strokes: [{ ...stroke, points: [0, 0] }] })), 'triples').toContain(
        'triples',
      );
      expect(
        rejection(file({ strokes: [{ ...stroke, points: [0, 0, Infinity] }] })),
        'finite',
      ).toContain('finite');
      expect(
        rejection(
          file({
            strokes: [{ ...stroke, points: new Array(LIMITS.maxStrokeNumbers + 3).fill(0) }],
          }),
        ),
        'too many points',
      ).toContain('triples');
    });

    it('when lists are not lists then the file is refused', () => {
      expect(rejection(file({ blocks: {} })), 'message').toContain('blocks must be a list');
    });

    it('when the title is too long then the file is refused', () => {
      expect(rejection(file({ title: 'x'.repeat(201) })), 'message').toContain('title');
    });
  });

  describe('round trip through a document', () => {
    it('when a board is exported and written into an empty one then the content is identical', () => {
      const source = new BoardDoc();
      const a = source.addBlock({
        type: 'core.sticky',
        x: 1,
        y: 2,
        w: 100,
        h: 80,
        text: 'hi',
        props: { color: '#fde68a' },
      });
      const b = source.addBlock({
        type: 'core.shape',
        x: 300,
        y: 2,
        w: 100,
        h: 80,
        props: { kind: 'ellipse' },
      });
      source.addConnector({ block: a, anchor: 'right' }, { block: b, anchor: 'left' });
      source.addStroke([0, 0, 0.5, 10, 10, 0.5], { color: '#000000', size: 4 });

      const exported: BoardFile = parseBoardFile(
        JSON.parse(JSON.stringify(boardToFile(source, 'Board'))),
      );
      const target = new BoardDoc();
      writeBoardFile(target, exported);

      expect(target.blocks(), 'blocks').toEqual(source.blocks());
      expect(target.textOf(a), 'text').toBe('hi');
      expect(target.connectors(), 'connectors').toEqual(source.connectors());
      expect(target.strokes(), 'strokes').toEqual(source.strokes());
      expect(exported.title, 'title').toBe('Board');
    });
  });

  describe('kanban (S5.5)', () => {
    const COL = '11111111-1111-4111-8111-111111111111';
    const CARD = '22222222-2222-4222-8222-222222222222';
    const kanban = (props: Record<string, unknown>): Record<string, unknown> =>
      file({ blocks: [block({ type: KANBAN_TYPE, text: undefined, props })] });
    const valid = (): Record<string, unknown> => ({
      title: 'Sprint',
      columns: [{ id: COL, title: 'To do', order: 1 }],
      cards: [
        {
          id: CARD,
          column: COL,
          order: 1,
          title: 'A',
          assignee: 'Ada',
          due: '2026-12-24',
          labels: ['red', 'red', 'blue'],
          points: 5,
          extra: 'dropped',
        },
      ],
    });

    it('when a kanban is valid then columns and cards are kept, unknown keys dropped', () => {
      const parsed = parseBoardFile(kanban(valid()));

      expect(parsed.blocks[0]?.props, 'props').toEqual({
        title: 'Sprint',
        columns: [{ id: COL, title: 'To do', order: 1 }],
        cards: [
          {
            id: CARD,
            column: COL,
            order: 1,
            title: 'A',
            assignee: 'Ada',
            due: '2026-12-24',
            labels: ['red', 'blue'],
            points: 5,
          },
        ],
      });
    });

    it('when kanban props break the rules then the file is refused', () => {
      const card = (patch: Record<string, unknown>): Record<string, unknown> => ({
        ...valid(),
        cards: [{ ...(valid()['cards'] as Record<string, unknown>[])[0], ...patch }],
      });
      const cases: [Record<string, unknown>, string][] = [
        [{ ...valid(), columns: 'x' }, 'must be a list'],
        [{ ...valid(), columns: [{ id: '__proto__', title: 'x', order: 1 }] }, 'not a valid id'],
        [{ ...valid(), columns: [{ id: COL }, { id: COL }] }, 'share an id'],
        [card({ column: '33333333-3333-4333-8333-333333333333' }), 'does not exist'],
        [card({ labels: ['constructor'] }), 'unknown label'],
        [card({ due: '2026-02-30' }), 'not a date'],
        [card({ points: 1000 }), 'points'],
        [card({ points: Number.NaN }), 'points'],
        [card({ assignee: 'x'.repeat(65) }), 'assignee'],
        [card({ title: 'x'.repeat(201) }), 'title of kanban card'],
        [card({ id: 'B1' }), 'not a valid id'],
        [
          {
            ...valid(),
            columns: Array.from({ length: KANBAN_LIMITS.maxColumns + 1 }, (_, i) => ({
              id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
            })),
          },
          'more than 20 kanban columns',
        ],
        [
          { ...valid(), cards: [...Array(KANBAN_LIMITS.maxCards + 1)].map(() => ({})) },
          'more than 500',
        ],
      ];
      for (const [props, message] of cases) {
        expect(rejection(kanban(props)), JSON.stringify(props).slice(0, 80)).toContain(message);
      }
    });

    it('when a kanban is exported and imported then the board shows the same columns and cards', () => {
      const source = new BoardDoc();
      const id = source.addBlock({
        type: KANBAN_TYPE,
        x: 0,
        y: 0,
        w: 700,
        h: 400,
        props: newKanbanProps('Sprint', ['A', 'B']),
      });
      const model = new KanbanModel(source, id);
      const card = model.addCard(model.read().columns[1]?.id as string, 'Card') as string;
      model.updateCard(card, { labels: ['green'], points: 8 });

      const exported = boardToFile(source, 'T');
      const target = new BoardDoc();
      writeBoardFile(target, parseBoardFile(JSON.parse(JSON.stringify(exported))));

      expect(new KanbanModel(target, id).read(), 'same').toEqual(model.read());
      expect(
        (exported.blocks[0]?.props['cards'] as unknown[]).length,
        'cards as a list in board.json',
      ).toBe(1);
      source.destroy();
      target.destroy();
    });
  });

  describe('story card (S5.5)', () => {
    const CRIT = '11111111-1111-4111-8111-111111111111';
    const story = (props: Record<string, unknown>, text = 'Title'): Record<string, unknown> =>
      file({ blocks: [block({ type: STORY_TYPE, text, props })] });

    it('when a story is valid then it is kept and a round id is dropped', () => {
      const parsed = parseBoardFile(
        story({
          description: 'D',
          criteria: [{ id: CRIT, text: 'C', done: true }],
          estimate: '13',
          pokerRoundId: '0192aaaa-0000-7000-8000-000000000001',
        }),
      );

      expect(parsed.blocks[0]?.props, 'props').toEqual({
        description: 'D',
        criteria: [{ id: CRIT, text: 'C', done: true }],
        estimate: '13',
      });
    });

    it('when story props break the rules then the file is refused', () => {
      const cases: [Record<string, unknown>, string, string?][] = [
        [{ estimate: '123456789' }, 'story estimate'],
        [{ estimate: 5 }, 'story estimate'],
        [{ description: 'x'.repeat(10_001) }, 'story description'],
        [{ criteria: [{ id: 'x', text: 'C' }] }, 'no valid id'],
        [{ criteria: [{ id: CRIT }, { id: CRIT }] }, 'share an id'],
        [{ criteria: [{ id: CRIT, done: 'yes' }] }, 'true or false'],
        [{ criteria: ['x'] }, 'not an object'],
        [{}, 'at most 200', 'x'.repeat(201)],
      ];
      for (const [props, message, text] of cases) {
        expect(rejection(story(props, text)), JSON.stringify(props).slice(0, 60)).toContain(
          message,
        );
      }
    });

    it('when a story is exported and imported then title, text and criteria are the same', () => {
      const source = new BoardDoc();
      const id = source.addBlock({
        type: STORY_TYPE,
        x: 0,
        y: 0,
        w: 300,
        h: 200,
        props: newStoryProps(),
        text: 'Story',
      });
      const model = new StoryModel(source, id);
      model.setDescription('Why');
      model.addCriterion('What');
      model.setEstimate('3');

      const target = new BoardDoc();
      writeBoardFile(target, parseBoardFile(JSON.parse(JSON.stringify(boardToFile(source, 'T')))));

      expect(new StoryModel(target, id).read(), 'same').toEqual(model.read());
      source.destroy();
      target.destroy();
    });
  });

  describe('splitBoardFile', () => {
    it('when the file is small then there is one piece with everything', () => {
      const parsed = parseBoardFile(file({ strokes: [{ id: 's1', points: [0, 0, 1] }] }));

      const pieces = splitBoardFile(parsed, 1_000_000);

      expect(pieces.length, 'pieces').toBe(1);
      expect(pieces[0]?.strokes.length, 'strokes').toBe(1);
    });

    it('when the file is big then the pieces stay small and together hold every item once', () => {
      const many = Array.from({ length: 50 }, (_, i) =>
        block({ id: `b${i}`, text: 'x'.repeat(1000) }),
      );
      const parsed = parseBoardFile(file({ blocks: many }));

      const pieces = splitBoardFile(parsed, 5000);

      expect(pieces.length, 'pieces').toBeGreaterThan(5);
      expect(
        pieces.flatMap((p) => p.blocks).map((b) => b.id),
        'ids in order',
      ).toEqual(parsed.blocks.map((b) => b.id));
      expect(
        Math.max(...pieces.map((p) => JSON.stringify(p.blocks).length)),
        'largest piece',
      ).toBeLessThan(7000);
    });

    it('when the file is empty then there are no pieces', () => {
      expect(splitBoardFile(parseBoardFile(file({ blocks: [] })), 1000).length, 'pieces').toBe(0);
    });

    it('when pieces are written one after the other then the document equals the original', () => {
      const parsed = parseBoardFile(
        file({ blocks: [block(), block({ id: 'b2', text: 'y'.repeat(100) })] }),
      );
      const target = new BoardDoc();

      splitBoardFile(parsed, 50).forEach((piece) => writeBoardFile(target, piece));

      expect(target.blockIds().sort(), 'blocks').toEqual(['b1', 'b2']);
    });
  });
});
