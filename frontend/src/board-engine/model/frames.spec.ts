import * as Y from 'yjs';

import { BoardDoc } from './board-doc';
import {
  FRAME_MAX_DEPTH,
  FrameTree,
  adoptInto,
  assignParents,
  frameAt,
  removeFramesKeepContents,
  topLevelOf,
  withDescendants,
} from './frames';

describe('frames', () => {
  let board: BoardDoc;
  beforeEach(() => (board = new BoardDoc()));
  afterEach(() => board.destroy());

  const frame = (
    x: number,
    y: number,
    w: number,
    h: number,
    parent: string | null = null,
  ): string => board.addBlock({ type: 'core.frame', x, y, w, h, parent, text: 'F' });
  const sticky = (x: number, y: number, parent: string | null = null): string =>
    board.addBlock({ type: 'core.sticky', x, y, w: 40, h: 40, parent });
  const setParent = (id: string, parent: string | null): void =>
    board.transact(() => board.blocksMap.get(id)?.set('parent', parent));

  describe('FrameTree', () => {
    it('when frames nest then parents, children, descendants, ancestors and depths follow', () => {
      const outer = frame(0, 0, 1000, 1000);
      const inner = frame(10, 10, 500, 500, outer);
      const note = sticky(20, 50, inner);

      const tree = new FrameTree(board);

      expect(tree.parent(note), 'parent').toBe(inner);
      expect(tree.children(outer), 'children').toEqual([inner]);
      expect(tree.descendants(outer), 'descendants').toEqual([inner, note]);
      expect(tree.ancestors(note), 'ancestors').toEqual([inner, outer]);
      expect([tree.depth(outer), tree.depth(inner), tree.depth(note)], 'depths').toEqual([1, 2, 2]);
      expect([tree.height(outer), tree.height(note)], 'heights').toEqual([2, 0]);
    });

    it('when a link dangles or points at a non-frame then it does not count', () => {
      const other = sticky(0, 0);
      const a = sticky(0, 0, other);
      const b = sticky(0, 0, 'gone');

      const tree = new FrameTree(board);

      expect(tree.parent(a), 'non-frame parent').toBeNull();
      expect(tree.parent(b), 'missing parent').toBeNull();
      expect(tree.depth(a), 'no depth').toBe(0);
    });

    it('when frames contain each other after a merge then both are top-level and nothing loops', () => {
      const a = frame(0, 0, 100, 100);
      const b = frame(0, 0, 100, 100, a);
      const note = sticky(10, 10, b);
      setParent(a, b);
      const self = frame(0, 0, 10, 10);
      setParent(self, self);

      const tree = new FrameTree(board);

      expect(tree.parent(a), 'a on the cycle').toBeNull();
      expect(tree.parent(b), 'b on the cycle').toBeNull();
      expect(tree.parent(note), 'a block hanging off keeps its link').toBe(b);
      expect(tree.parent(self), 'own parent').toBeNull();
      expect(withDescendants(board, [a]), 'moving a takes nothing of b').toEqual([a]);
    });

    it('when frames nest deeper than the limit then the too-deep frame is top-level', () => {
      const chain = [frame(0, 0, 10, 10)];
      for (let i = 1; i <= FRAME_MAX_DEPTH; i++) {
        chain.push(frame(0, 0, 10, 10, chain[i - 1]));
      }

      const tree = new FrameTree(board);

      expect(tree.depth(chain[FRAME_MAX_DEPTH - 1] ?? ''), 'deepest allowed').toBe(FRAME_MAX_DEPTH);
      expect(tree.parent(chain[FRAME_MAX_DEPTH] ?? ''), 'ninth: top-level').toBeNull();
      expect(tree.depth(chain[FRAME_MAX_DEPTH] ?? ''), 'its depth').toBe(1);
    });
  });

  describe('membership', () => {
    it('when a block lies in nested frames then the innermost one under its centre is its frame', () => {
      const outer = frame(0, 0, 1000, 1000);
      const inner = frame(100, 100, 300, 300, outer);
      const inInner = sticky(200, 200);
      const inOuter = sticky(600, 600);
      const outside = sticky(2000, 2000);

      assignParents(board, [inInner, inOuter, outside]);

      expect(board.getBlock(inInner)?.parent, 'inner').toBe(inner);
      expect(board.getBlock(inOuter)?.parent, 'outer').toBe(outer);
      expect(board.getBlock(outside)?.parent, 'none').toBeNull();
    });

    it('when a block is dragged out then its parent is cleared, also a link that did not count', () => {
      const f = frame(0, 0, 100, 100);
      const note = sticky(10, 10, f);
      const dangling = sticky(500, 500, 'gone');
      board.setGeometry(note, { x: 500 });

      assignParents(board, [note, dangling]);

      expect(board.getBlock(note)?.parent, 'out').toBeNull();
      expect(board.getBlock(dangling)?.parent, 'cleared').toBeNull();
    });

    it('when a frame is dropped then never into itself or a frame inside it', () => {
      const outer = frame(0, 0, 1000, 1000);
      const inner = frame(400, 400, 200, 200, outer);

      expect(frameAt(board, outer), 'not into its own child').toBeNull();
      expect(frameAt(board, inner), 'its frame').toBe(outer);
    });

    it('when the target frame has no room for another level then the next one out is taken', () => {
      const chain = [frame(0, 0, 100, 100)];
      for (let i = 1; i < FRAME_MAX_DEPTH; i++) {
        chain.push(frame(0, 0, 100, 100, chain[i - 1]));
      }
      const extra = frame(40, 40, 20, 20);
      const note = sticky(0, 0); // centre 20,20: not in the extra frame

      assignParents(board, [extra, note]);

      expect(board.getBlock(extra)?.parent, 'a frame: one level up').toBe(
        chain[FRAME_MAX_DEPTH - 2],
      );
      expect(board.getBlock(note)?.parent, 'a note: the deepest').toBe(chain[FRAME_MAX_DEPTH - 1]);
    });

    it('when two frames overlap at the same depth then the one on top wins', () => {
      frame(0, 0, 100, 100);
      const top = frame(0, 0, 100, 100);
      const note = sticky(10, 10);

      assignParents(board, [note]);

      expect(board.getBlock(note)?.parent, 'top frame').toBe(top);
    });

    it('when a frame is created or resized over blocks then it takes in those on its level only', () => {
      const other = frame(500, 0, 300, 300);
      const inOther = sticky(560, 100, other);
      const loose = sticky(100, 100);
      const f = frame(0, 0, 400, 400);

      adoptInto(board, f);
      board.setGeometry(f, { w: 800 });
      adoptInto(board, f);

      expect(board.getBlock(loose)?.parent, 'loose note taken in').toBe(f);
      expect(board.getBlock(other)?.parent, 'the other frame too (same level)').toBe(f);
      expect(board.getBlock(inOther)?.parent, 'its note stays in it').toBe(other);
      expect(adoptInto(board, sticky(0, 0)), 'not a frame: nothing').toBeUndefined();
    });

    it('when the top level of a moved set is asked for then blocks inside moved frames are not in it', () => {
      const f = frame(0, 0, 100, 100);
      const note = sticky(10, 10, f);
      const loose = sticky(500, 500);
      const stroke = board.addStroke([0, 0, 0.5], { color: '#000000', size: 2 });

      expect(topLevelOf(board, [f, note, loose, stroke]), 'top level').toEqual([f, loose]);
    });
  });

  describe('cost', () => {
    it('when many blocks are assigned then the block shapes are read once, not per block', () => {
      frame(0, 0, 100_000, 100_000);
      const ids = Array.from({ length: 300 }, (_, i) => sticky(i * 50, 100));
      const spy = vi.spyOn(board, 'blockShapes');

      assignParents(board, ids);

      expect(spy, 'blockShapes calls').toHaveBeenCalledTimes(1);
      expect(
        ids.every((id) => board.getBlock(id)?.parent !== null),
        'all joined the frame',
      ).toBe(true);
    });

    it('when a frame holds a deep chain then descendants lists each block once in breadth order', () => {
      const outer = frame(0, 0, 1000, 1000);
      const left = frame(10, 10, 400, 400, outer);
      const right = frame(500, 10, 400, 400, outer);
      const a = sticky(20, 20, left);
      const b = sticky(520, 20, right);
      const many = Array.from({ length: 2000 }, (_, i) => sticky(i, 30, left));

      const found = new FrameTree(board).descendants(outer);

      expect(found.slice(0, 2), 'children first').toEqual([left, right]);
      expect(found.length, 'each once').toBe(4 + many.length);
      expect(new Set(found).size, 'no duplicates').toBe(found.length);
      expect(found, 'contains').toEqual(expect.arrayContaining([a, b]));
    });
  });

  describe('removeFramesKeepContents', () => {
    it('when a nested frame is removed then its children move to the frame around it', () => {
      const outer = frame(0, 0, 1000, 1000);
      const inner = frame(10, 10, 500, 500, outer);
      const note = sticky(20, 50, inner);

      removeFramesKeepContents(board, [inner, note]);

      expect(board.hasBlock(inner), 'frame gone').toBe(false);
      expect(board.getBlock(note)?.parent, 'note kept, now in outer').toBe(outer);
    });

    it('when a frame and the frame around it are removed then the contents end on the board', () => {
      const outer = frame(0, 0, 1000, 1000);
      const inner = frame(10, 10, 500, 500, outer);
      const note = sticky(20, 50, inner);

      removeFramesKeepContents(board, [outer, inner]);

      expect(
        board.blocks().map((b) => b.id),
        'only the note',
      ).toEqual([note]);
      expect(board.getBlock(note)?.parent, 'top level').toBeNull();
    });
  });

  describe('collaboration', () => {
    it('when two clients move frames into each other at once then both converge to the same tree', () => {
      const a = new BoardDoc(new Y.Doc());
      const b = new BoardDoc(new Y.Doc());
      const one = a.addBlock({ type: 'core.frame', x: 0, y: 0, w: 100, h: 100 });
      const two = a.addBlock({ type: 'core.frame', x: 200, y: 0, w: 100, h: 100 });
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

      a.transact(() => a.blocksMap.get(one)?.set('parent', two));
      b.transact(() => b.blocksMap.get(two)?.set('parent', one));
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));

      const [ta, tb] = [new FrameTree(a), new FrameTree(b)];
      expect([ta.parent(one), ta.parent(two)], 'a: both top-level').toEqual([null, null]);
      expect([tb.parent(one), tb.parent(two)], 'b: the same').toEqual([null, null]);
      expect(withDescendants(a, [one]), 'a move ends').toEqual([one]);
      a.destroy();
      b.destroy();
    });
  });
});
