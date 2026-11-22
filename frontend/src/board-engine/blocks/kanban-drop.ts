import {
  BoardDoc,
  Point,
  screenToWorld,
  isFrame,
  KANBAN_LIMITS,
  KANBAN_TYPE,
  KanbanModel,
  detailBytes,
  kanbanDetailBytes,
  STORY_TYPE,
  readStory,
} from '@apps/drawboard-engine';
import type { ToolContext } from '../tools/tool';
import { ColumnTarget, columnTargetAt } from './kanban';
import { cardFromStory } from './kanban-story';

/** What dropping the dragged blocks at a point would do. */
export type StoryDrop =
  /** Not a drop into a kanban: the blocks are just moved. */
  | { kind: 'none' }
  /** A drop into a kanban that is not allowed; `notice` says why (no highlight is shown). */
  | { kind: 'blocked'; notice: string }
  | { kind: 'accept'; kanbanId: string; root: HTMLElement; target: ColumnTarget };

export const DETAILS_NOTICE =
  'This kanban cannot hold that much description text. Shorten the stories or use another kanban';
export const ESTIMATING_NOTICE = 'Finish or cancel the estimation first';

/** The mounted kanbans, found once per drag (a drag does not add or remove blocks). */
export interface DropCandidates {
  kanbans?: { id: string; root: HTMLElement; z: number }[];
}

/**
 * Where do story cards that are dragged to `screen` go? Only a selection that consists of
 * story cards and nothing else counts (anything else keeps the old behaviour: it is moved);
 * the kanban is the topmost one whose rendered area holds the pointer and that no other block
 * (not dragged, higher up) covers there, the column the one under the pointer. A story whose
 * planning poker round the SERVER lists as open (`estimates.isOpen`, never the card's own
 * `pokerRoundId`, any editor can clear that) blocks the drop. While dragging only that and the
 * hit test run; `final` (the release) also counts the room: cards and detail bytes.
 */
export function planStoryDrop(
  ctx: ToolContext,
  ids: readonly string[],
  screen: Point,
  final = false,
  cache: DropCandidates = {},
): StoryDrop {
  const board = ctx.board;
  if (ctx.readOnly || ids.length === 0 || !ids.every((id) => isStory(board, id))) {
    return { kind: 'none' };
  }
  const at = ctx.clientAt(screen);
  cache.kanbans ??= mountedKanbans(ctx);
  const hit = kanbanAt(cache.kanbans, at);
  if (!hit || covered(ctx, hit.id, hit.z, ids, screenToWorld(ctx.camera, screen))) {
    return { kind: 'none' };
  }
  const target = columnTargetAt(hit.root, at.x, at.y);
  if (!target) {
    return { kind: 'none' };
  }
  if (ids.some((id) => ctx.estimates?.isOpen(id) === true)) {
    return { kind: 'blocked', notice: ESTIMATING_NOTICE };
  }
  if (final) {
    const state = new KanbanModel(board, hit.id).read();
    const room = KANBAN_LIMITS.maxCards - state.columns.reduce((n, c) => n + c.cards.length, 0);
    if (ids.length > room) {
      return {
        kind: 'blocked',
        notice:
          room > 0
            ? `This kanban has room for ${room} more cards`
            : 'This kanban cannot take more cards',
      };
    }
    const added = ids.reduce((n, id) => {
      const story = readStory(board, id);
      return n + detailBytes(story.description, story.criteria);
    }, 0);
    if (kanbanDetailBytes(state) + added > KANBAN_LIMITS.maxDetailBytes) {
      return { kind: 'blocked', notice: DETAILS_NOTICE };
    }
  }
  return { kind: 'accept', kanbanId: hit.id, root: hit.root, target };
}

/**
 * Turns the story cards into cards of the target column - in the order of their position, top
 * to bottom - and deletes them, in ONE transaction and one undo step. Returns false (nothing
 * changed) if the kanban refused them.
 */
export function dropStories(
  ctx: ToolContext,
  ids: readonly string[],
  drop: Extract<StoryDrop, { kind: 'accept' }>,
): boolean {
  const board = ctx.board;
  const stories = [...ids]
    .map((id) => ({ id, block: board.getBlock(id) }))
    .filter((s) => s.block)
    .sort(
      (a, b) =>
        (a.block?.y ?? 0) - (b.block?.y ?? 0) ||
        (a.block?.x ?? 0) - (b.block?.x ?? 0) ||
        (a.id < b.id ? -1 : 1),
    );
  const model = new KanbanModel(board, drop.kanbanId, () => ctx.stopCapturing());
  let done = false;
  ctx.stopCapturing();
  board.transact(() => {
    done =
      model.addStoryCards(
        drop.target.columnId,
        drop.target.index,
        stories.map((s) => cardFromStory(readStory(board, s.id))),
      ) !== undefined;
    if (done) {
      board.deleteItems(stories.map((s) => s.id));
    }
  });
  ctx.stopCapturing();
  if (done) {
    ctx.selection.set([drop.kanbanId]);
  }
  return done;
}

function isStory(board: BoardDoc, id: string): boolean {
  return board.getBlock(id)?.type === STORY_TYPE;
}

/** Every mounted kanban with its rendered root. */
function mountedKanbans(ctx: ToolContext): { id: string; root: HTMLElement; z: number }[] {
  const out: { id: string; root: HTMLElement; z: number }[] = [];
  for (const block of ctx.board.blocks()) {
    const root =
      block.type === KANBAN_TYPE
        ? ctx.blockElement(block.id)?.querySelector<HTMLElement>('.be-kanban')
        : undefined;
    if (root) {
      out.push({ id: block.id, root, z: block.z });
    }
  }
  return out;
}

/** The topmost of the kanbans whose rendered area holds the viewport point. */
function kanbanAt(
  kanbans: readonly { id: string; root: HTMLElement; z: number }[],
  at: Point,
): { id: string; root: HTMLElement; z: number } | undefined {
  let best: { id: string; root: HTMLElement; z: number } | undefined;
  for (const k of kanbans) {
    const r = k.root.getBoundingClientRect();
    if (at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom) {
      if (!best || k.z >= best.z) {
        best = k;
      }
    }
  }
  return best;
}

/** Is a block that is not dragged and lies above the kanban at the world point? */
function covered(
  ctx: ToolContext,
  kanbanId: string,
  z: number,
  dragged: readonly string[],
  world: Point,
): boolean {
  const skip = new Set(dragged);
  return ctx.board
    .blocks()
    .some(
      (b) =>
        b.id !== kanbanId &&
        !skip.has(b.id) &&
        !isFrame(b) &&
        b.z > z &&
        world.x >= b.x &&
        world.x <= b.x + b.w &&
        world.y >= b.y &&
        world.y <= b.y + b.h,
    );
}
