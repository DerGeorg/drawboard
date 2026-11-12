import * as Y from 'yjs';

import { BoardDoc, LOCAL_ORIGIN, anchorPoint, movePoints } from './board-doc';
import { BoardChange } from './types';

function sticky(board: BoardDoc, x = 0, y = 0, text = 'hi'): string {
  return board.addBlock({
    type: 'core.sticky',
    x,
    y,
    w: 100,
    h: 80,
    props: { color: '#fff' },
    text,
  });
}

describe('BoardDoc', () => {
  let board: BoardDoc;
  beforeEach(() => (board = new BoardDoc()));
  afterEach(() => board.destroy());

  describe('creation', () => {
    it('when a board is created then the schema version is set', () => {
      expect(board.schemaVersion, 'schema version').toBe(1);
    });

    it('when a document already has a schema version then it is kept', () => {
      const doc = new Y.Doc();
      doc.getMap('meta').set('schemaVersion', 7);

      expect(new BoardDoc(doc).schemaVersion, 'existing version').toBe(7);
    });
  });

  describe('addBlock', () => {
    it('when blocks are added then ids are uuids and z grows by one', () => {
      const a = sticky(board);
      const b = sticky(board);

      expect(a, 'uuid').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(board.getBlock(b)?.z, 'z of the second block').toBe((board.getBlock(a)?.z ?? 0) + 1);
    });

    it('when a block has text then the Y.Text holds it and props are readable', () => {
      const id = sticky(board, 5, 6, 'hello');

      expect(board.textOf(id), 'text').toBe('hello');
      expect(board.getBlock(id), 'block').toMatchObject({
        x: 5,
        y: 6,
        w: 100,
        h: 80,
        props: { color: '#fff' },
        hasText: true,
      });
    });

    it('when a block has no text then textOf is empty', () => {
      const id = board.addBlock({ type: 'x', x: 0, y: 0, w: 10, h: 10 });

      expect(board.textOf(id), 'text').toBe('');
      expect(board.getBlock(id)?.hasText, 'has text').toBe(false);
    });

    it('when the text is longer than the limit then it is cut', () => {
      const id = sticky(board, 0, 0, 'x'.repeat(100_050));

      expect(board.textOf(id).length, 'text length').toBe(100_000);
    });
  });

  describe('mutations', () => {
    it('when geometry is set then only finite values change', () => {
      const id = sticky(board);

      board.setGeometry(id, { x: 10, w: Number.NaN });

      expect(board.getBlock(id), 'block').toMatchObject({ x: 10, w: 100 });
    });

    it('when a prop is set then it is readable', () => {
      const id = sticky(board);

      board.setProp(id, 'color', '#000');

      expect(board.getBlock(id)?.props['color'], 'color').toBe('#000');
    });

    it('when a block is locked then it does not move', () => {
      const id = sticky(board);
      board.setBlockFlag(id, 'locked', true);

      board.moveItems([id], 5, 5);

      expect(board.getBlock(id), 'block').toMatchObject({ x: 0, y: 0, locked: true });
    });

    it('when blocks are brought to front then they get the highest z', () => {
      const a = sticky(board);
      sticky(board);

      board.bringToFront([a]);

      expect(board.getBlock(a)?.z, 'z').toBe(board.maxZ());
    });

    it('when items are moved then blocks, strokes and free connector ends move', () => {
      const b = sticky(board);
      const s = board.addStroke([0, 0, 0.5, 10, 10, 0.5], { color: '#000', size: 2 });
      const c = board.addConnector({ x: 1, y: 1 }, { block: b, anchor: 'auto' });

      board.moveItems([b, s, c], 3, 4);

      expect(board.getBlock(b), 'block').toMatchObject({ x: 3, y: 4 });
      expect(board.getStroke(s)?.points, 'stroke points').toEqual([3, 4, 0.5, 13, 14, 0.5]);
      expect(board.getConnector(c)?.from, 'free end').toEqual({ x: 4, y: 5 });
      expect(board.getConnector(c)?.to, 'block end').toEqual({ block: b, anchor: 'auto' });
    });

    it('when moving by zero then nothing is written', () => {
      const id = sticky(board);
      const listener = vi.fn();
      board.observe(listener);

      board.moveItems([id], 0, 0);

      expect(listener, 'listener').not.toHaveBeenCalled();
    });

    it('when a block is deleted then connectors attached to it go too', () => {
      const a = sticky(board);
      const b = sticky(board);
      const c = board.addConnector({ block: a, anchor: 'auto' }, { block: b, anchor: 'auto' });
      const free = board.addConnector({ x: 0, y: 0 }, { x: 5, y: 5 });

      board.deleteItems([a]);

      expect(board.hasBlock(a), 'deleted block').toBe(false);
      expect(board.getConnector(c), 'attached connector').toBeUndefined();
      expect(board.getConnector(free), 'free connector').toBeDefined();
    });

    it('when blocks are duplicated then copies keep props and text, and inner connectors are copied', () => {
      const a = sticky(board, 0, 0, 'A');
      const b = sticky(board, 200, 0, 'B');
      const c = board.addConnector({ block: a, anchor: 'right' }, { block: b, anchor: 'left' });
      const s = board.addStroke([0, 0, 0.5], { color: '#111', size: 3 });

      const created = board.duplicate([a, b, c, s], 10, 20);

      expect(created.length, 'created ids: 2 blocks, 1 connector, 1 stroke').toBe(4);
      const copies = board.blocks().filter((x) => created.includes(x.id));
      expect(copies.map((x) => [x.x, x.y]).sort(), 'offset positions').toEqual([
        [10, 20],
        [210, 20],
      ]);
      expect(copies.map((x) => board.textOf(x.id)).sort(), 'texts').toEqual(['A', 'B']);
      const copyConnector = board.connectors().find((x) => created.includes(x.id));
      expect(
        copyConnector &&
          'block' in copyConnector.from &&
          created.includes(copyConnector.from.block),
        'connector points at copies',
      ).toBe(true);
    });

    it('when a connector is duplicated without one of its blocks then it is not copied', () => {
      const a = sticky(board);
      const b = sticky(board);
      const c = board.addConnector({ block: a, anchor: 'auto' }, { block: b, anchor: 'auto' });

      const created = board.duplicate([a, c], 5, 5);

      expect(created.length, 'only the block').toBe(1);
    });
  });

  describe('connectors and strokes', () => {
    it('when a connector is updated then label and ends change and style merges', () => {
      const c = board.addConnector({ x: 0, y: 0 }, { x: 1, y: 1 });

      board.updateConnector(c, { label: 'yes', to: { x: 9, y: 9 } });
      board.setConnectorStyle(c, { width: 5 });

      expect(board.getConnector(c), 'connector').toMatchObject({
        label: 'yes',
        to: { x: 9, y: 9 },
        style: { width: 5, arrow: true },
      });
    });

    it('when a stroke style is set then it merges', () => {
      const s = board.addStroke([0, 0, 0.5], { color: '#000', size: 2 });

      board.setStrokeStyle(s, { color: '#f00' });

      expect(board.getStroke(s)?.style, 'style').toEqual({ color: '#f00', size: 2 });
    });

    it('when ids are unknown then reads and writes are no-ops', () => {
      board.setGeometry('x', { x: 1 });
      board.setProp('x', 'a', 1);
      board.updateConnector('x', { label: 'a' });
      board.setStrokeStyle('x', { size: 1 });
      board.setConnectorStyle('x', { width: 1 });

      expect(board.getBlock('x'), 'block').toBeUndefined();
      expect(board.getConnector('x'), 'connector').toBeUndefined();
      expect(board.getStroke('x'), 'stroke').toBeUndefined();
    });
  });

  describe('anchors', () => {
    const rect = { x: 0, y: 0, w: 100, h: 50 };

    it.each([
      ['top', { x: 50, y: 0 }],
      ['right', { x: 100, y: 25 }],
      ['bottom', { x: 50, y: 50 }],
      ['left', { x: 0, y: 25 }],
    ] as const)('when the anchor is %s then the side midpoint is used', (anchor, expected) => {
      expect(anchorPoint(rect, anchor, { x: 0, y: 0 }), 'point').toEqual(expected);
    });

    it('when the anchor is auto then the side facing the target is used', () => {
      expect(anchorPoint(rect, 'auto', { x: 500, y: 25 }), 'target right').toEqual({
        x: 100,
        y: 25,
      });
      expect(anchorPoint(rect, 'auto', { x: -500, y: 25 }), 'target left').toEqual({ x: 0, y: 25 });
      expect(anchorPoint(rect, 'auto', { x: 50, y: 500 }), 'target below').toEqual({
        x: 50,
        y: 50,
      });
      expect(anchorPoint(rect, 'auto', { x: 50, y: -500 }), 'target above').toEqual({
        x: 50,
        y: 0,
      });
    });

    it('when a connector end points to a missing block then it does not resolve', () => {
      expect(
        board.resolveEnd({ block: 'gone', anchor: 'auto' }, { x: 0, y: 0 }),
        'resolved',
      ).toBeUndefined();
      expect(board.resolveEnd({ x: 3, y: 4 }, { x: 0, y: 0 }), 'free point').toEqual({
        x: 3,
        y: 4,
      });
    });
  });

  describe('observe', () => {
    it('when a block is added then the change names it and is local', () => {
      const changes: BoardChange[] = [];
      board.observe((c) => changes.push(c));

      const id = sticky(board);

      expect(changes.at(-1)?.blocks.has(id), 'block id').toBe(true);
      expect(changes.at(-1)?.local, 'local').toBe(true);
    });

    it('when only the text changes then the change still names the block', () => {
      const id = sticky(board);
      const changes: BoardChange[] = [];
      board.observe((c) => changes.push(c));

      board.transact(() => board.getText(id)?.insert(0, 'x'));

      expect([...(changes.at(-1)?.blocks ?? [])], 'blocks').toEqual([id]);
    });

    it('when a prop changes then the cached block is refreshed', () => {
      const id = sticky(board);
      expect(board.getBlock(id)?.props['color'], 'before').toBe('#fff');

      board.setProp(id, 'color', '#000');

      expect(board.getBlock(id)?.props['color'], 'after').toBe('#000');
    });

    it('when a remote update is applied then the change is not local', () => {
      const remote = new BoardDoc();
      const id = sticky(remote);
      const changes: BoardChange[] = [];
      board.observe((c) => changes.push(c));

      Y.applyUpdate(board.doc, Y.encodeStateAsUpdate(remote.doc), 'remote');

      expect(changes.at(-1)?.local, 'local flag').toBe(false);
      expect(board.hasBlock(id), 'block arrived').toBe(true);
      remote.destroy();
    });

    it('when connector, stroke and meta change then each set is filled', () => {
      const changes: BoardChange[] = [];
      board.observe((c) => changes.push(c));

      const c = board.addConnector({ x: 0, y: 0 }, { x: 1, y: 1 });
      const s = board.addStroke([0, 0, 1], { color: '#000', size: 1 });
      board.doc.transact(() => board.meta.set('title', 'T'), LOCAL_ORIGIN);

      expect(
        changes.some((x) => x.connectors.has(c)),
        'connector',
      ).toBe(true);
      expect(
        changes.some((x) => x.strokes.has(s)),
        'stroke',
      ).toBe(true);
      expect(
        changes.some((x) => x.meta),
        'meta',
      ).toBe(true);
    });

    it('when unsubscribed then the listener is not called again', () => {
      const listener = vi.fn();
      const off = board.observe(listener);
      off();

      sticky(board);

      expect(listener, 'listener').not.toHaveBeenCalled();
    });
  });

  describe('movePoints', () => {
    it('when points are moved then pressure is kept', () => {
      expect(movePoints([1, 2, 0.3, 4, 5, 0.9], 1, 1), 'points').toEqual([2, 3, 0.3, 5, 6, 0.9]);
    });
  });
});
