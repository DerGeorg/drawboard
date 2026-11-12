import { KeyInfo, PointerInfo } from '../input/events';
import { BoardDoc } from '../model/board-doc';
import {
  FRAME_TITLE_HEIGHT,
  FrameTree,
  adoptInto,
  assignParents,
  isFrame,
  topLevelOf,
  withDescendants,
} from '../model/frames';
import { cellsToTables, isTableCell, resizeCell, resizeTable } from '../model/tables';
import { Point, Rect } from '../model/types';
import { itemBounds, itemsInRect } from '../scene';
import { normalizeRect } from '../util/geometry';
import { HandleId, Tool, ToolContext, ToolId } from './tool';
import { handleCursor, resizeRect } from './resize';

type Mode =
  | { kind: 'idle' }
  /** `ids`: what moves - the selection plus everything inside selected frames. */
  | { kind: 'move'; last: Point; moved: boolean; ids: string[] }
  | { kind: 'resize'; id: string; handle: HandleId; start: Point; initial: Rect }
  | { kind: 'marquee'; start: Point; base: string[] }
  /** Pressed on the empty inside of an unselected frame: a click selects it, a drag is a marquee. */
  | { kind: 'frame-press'; id: string; start: Point };

export const NUDGE = 1;
export const NUDGE_BIG = 10;
export const DUPLICATE_OFFSET = 24;

/**
 * What moving (copying, duplicating) the selection takes: the selection, a cell's whole table
 * instead of the cell, and everything inside the frames.
 */
export function moveSet(board: BoardDoc, ids: readonly string[]): string[] {
  return withDescendants(board, cellsToTables(board, ids));
}

/** After a move: the moved blocks (not those inside a moved frame) join the frame under them. */
export function rehome(board: BoardDoc, moved: readonly string[]): void {
  assignParents(board, topLevelOf(board, moved));
}

/** A delete that takes more than this many blocks from inside frames is announced. */
export const DELETE_NOTICE_MIN = 10;

/**
 * Deletes the selection with everything inside its frames. Returns a notice when more than
 * `DELETE_NOTICE_MIN` blocks went along with the frames (no confirmation: undo brings them back).
 */
export function deleteWithContents(board: BoardDoc, ids: readonly string[]): string | undefined {
  // a cell alone is not deleted (rows and columns go through the table's toolbar): a stray
  // Delete must not break the table
  const tree = new FrameTree(board);
  const chosen = ids.filter((id) => !isTableCell(board, id, tree));
  const all = withDescendants(board, chosen);
  board.deleteItems(all);
  const inside = all.length - new Set(chosen).size;
  return inside > DELETE_NOTICE_MIN ? `${all.length} items deleted - Ctrl+Z to undo` : undefined;
}

/**
 * Copies the selection (with everything inside its frames) next to the original and returns the
 * copies; a copy stays in the frame of its original unless that frame was copied too.
 */
export function duplicateWithContents(board: BoardDoc, ids: readonly string[]): string[] {
  let copies: string[] = [];
  board.transact(() => {
    copies = board.duplicate(moveSet(board, ids), DUPLICATE_OFFSET, DUPLICATE_OFFSET);
    assignParents(board, topLevelOf(board, copies));
  });
  return copies;
}

/** Select, move, resize, marquee; Delete, Escape, mod+A, mod+D, arrow nudge. */
export class SelectTool implements Tool {
  readonly id: ToolId = 'select';
  cursor = 'default';
  private mode: Mode = { kind: 'idle' };

  constructor(private readonly ctx: ToolContext) {}

  deactivate(): void {
    this.cancel();
  }

  pointerDown(e: PointerInfo): void {
    const { ctx } = this;
    ctx.stopCapturing();
    const handle = ctx.readOnly ? undefined : ctx.handleAt(e.screen);
    if (handle) {
      const id = ctx.selection.list()[0];
      const r = id ? itemBounds(ctx.board, id) : undefined;
      if (id && r) {
        this.mode = { kind: 'resize', id, handle, start: e.world, initial: r };
        return;
      }
    }
    const hit = ctx.hitTest(e.world);
    const frame = hit?.kind === 'block' ? ctx.board.getBlock(hit.id) : undefined;
    if (
      hit &&
      frame &&
      isFrame(frame) &&
      !e.shift &&
      !ctx.selection.has(hit.id) &&
      e.world.y - frame.y > FRAME_TITLE_HEIGHT
    ) {
      // the inside of a frame: select it on click, but a drag selects what is in it (Miro)
      this.mode = { kind: 'frame-press', id: hit.id, start: e.world };
      return;
    }
    if (hit) {
      if (e.shift) {
        ctx.selection.toggle(hit.id);
      } else if (!ctx.selection.has(hit.id)) {
        ctx.selection.set([hit.id]);
      }
      if (ctx.selection.has(hit.id) && !ctx.readOnly) {
        this.startMove(e.world);
      }
      return;
    }
    const base = e.shift ? ctx.selection.list() : [];
    if (!e.shift) {
      ctx.selection.clear();
    }
    this.mode = { kind: 'marquee', start: e.world, base };
  }

  pointerMove(e: PointerInfo): void {
    const { ctx } = this;
    const m = this.mode;
    switch (m.kind) {
      case 'move': {
        const dx = e.world.x - m.last.x;
        const dy = e.world.y - m.last.y;
        // a click without drag must not nudge anything: wait for ~3 screen pixels
        if (!m.moved && Math.hypot(dx, dy) < ctx.px(3)) {
          return;
        }
        ctx.board.moveItems(m.ids, dx, dy);
        this.mode = { ...m, last: e.world, moved: true };
        return;
      }
      case 'frame-press': {
        if (Math.hypot(e.world.x - m.start.x, e.world.y - m.start.y) >= ctx.px(3)) {
          ctx.selection.clear();
          this.mode = { kind: 'marquee', start: m.start, base: [] };
          this.pointerMove(e);
        }
        return;
      }
      case 'resize': {
        const r = resizeRect(
          m.initial,
          m.handle,
          e.world.x - m.start.x,
          e.world.y - m.start.y,
          e.shift,
        );
        // a cell sets its column's width and its row's height, a table scales its grid; both
        // lay the grid out again - anything else just takes the new rectangle
        if (!resizeCell(ctx.board, m.id, r) && !resizeTable(ctx.board, m.id, r)) {
          ctx.board.setGeometry(m.id, r);
        }
        return;
      }
      case 'marquee': {
        const rect = normalizeRect(m.start, e.world);
        ctx.setHints({ marquee: rect });
        ctx.selection.set([...m.base, ...itemsInRect(ctx.board, rect)]);
        return;
      }
      default: {
        const handle = ctx.handleAt(e.screen);
        this.cursor = handle ? handleCursor(handle) : ctx.hitTest(e.world) ? 'move' : 'default';
      }
    }
  }

  pointerUp(): void {
    const m = this.mode;
    if (m.kind === 'frame-press') {
      this.ctx.selection.set([m.id]);
    } else if (m.kind === 'move' && m.moved) {
      // in the same undo step as the move: the moved blocks join the frame they were dropped on
      rehome(this.ctx.board, m.ids);
    } else if (m.kind === 'resize' && isFrame(this.ctx.board.getBlock(m.id))) {
      // a resized frame takes in what it now covers; children outside stay children (Miro)
      adoptInto(this.ctx.board, m.id);
    }
    this.finish();
  }

  pointerCancel(): void {
    this.cancel();
  }

  doubleClick(e: PointerInfo): void {
    const id = this.ctx.blockAt(e.world);
    if (!id || this.ctx.readOnly) {
      return;
    }
    const block = this.ctx.board.getBlock(id);
    const type = block && this.ctx.registry.get(block.type);
    if (type?.textEditable) {
      this.ctx.selection.set([id]);
      this.ctx.startTextEdit(id);
    } else if (type?.opensEditor) {
      this.ctx.selection.set([id]);
      this.ctx.openBlock(id);
    }
  }

  keyDown(e: KeyInfo): boolean {
    const { ctx } = this;
    const ids = ctx.selection.list();
    if (e.mod && e.key.toLowerCase() === 'a') {
      ctx.selection.set([
        ...ctx.board.blockIds(),
        ...ctx.board.strokeIds(),
        ...ctx.board.connectorIds(),
      ]);
      return true;
    }
    if (e.key === 'Escape') {
      if (this.mode.kind !== 'idle') {
        this.cancel();
      } else {
        ctx.selection.clear();
      }
      return true;
    }
    if (ctx.readOnly || ids.length === 0) {
      return false;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      ctx.stopCapturing();
      const notice = deleteWithContents(ctx.board, ids);
      ctx.selection.clear();
      if (notice) {
        ctx.notify(notice);
      }
      return true;
    }
    if (e.mod && e.key.toLowerCase() === 'd') {
      ctx.stopCapturing();
      ctx.selection.set(duplicateWithContents(ctx.board, ids));
      return true;
    }
    if (e.key === 'Enter' && ids.length === 1 && ids[0]) {
      const block = ctx.board.getBlock(ids[0]);
      const type = block ? ctx.registry.get(block.type) : undefined;
      if (type?.textEditable) {
        ctx.startTextEdit(ids[0]);
        return true;
      }
      // the keyboard way of a double-click on a block with an editor of its own (story, diagram)
      if (type?.opensEditor && !ctx.readOnly) {
        ctx.openBlock(ids[0]);
        return true;
      }
    }
    const step = e.shift ? NUDGE_BIG : NUDGE;
    const arrow: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = arrow[e.key];
    if (delta) {
      const moving = moveSet(ctx.board, ids);
      ctx.board.transact(() => {
        ctx.board.moveItems(moving, delta.x, delta.y);
        rehome(ctx.board, moving);
      });
      return true;
    }
    return false;
  }

  private startMove(at: Point): void {
    this.mode = {
      kind: 'move',
      last: at,
      moved: false,
      ids: moveSet(this.ctx.board, this.ctx.selection.list()),
    };
  }

  private finish(): void {
    this.mode = { kind: 'idle' };
    this.ctx.setHints({});
    this.ctx.stopCapturing();
  }

  private cancel(): void {
    this.finish();
  }
}
