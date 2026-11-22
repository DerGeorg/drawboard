import { BlockShape, BoardDoc } from './board-doc.js';
import { Point } from './types.js';

/**
 * Frames: blocks of type `core.frame` that contain other blocks through the `parent` field of
 * the schema (architecture 3.3). This module is the one place that decides what a parent link
 * means; renderer, hit-testing, tools, clipboard and import all ask it.
 *
 * The document is edited by several clients at once, so a parent link can be anything after a
 * merge: missing, pointing at a non-frame, part of a cycle (A moved into B while B was moved
 * into A), or nested too deep. Every client reads it with the same deterministic rule, so all of
 * them see the same tree and nothing loops:
 *
 * - a link counts only if it points at an existing frame;
 * - frames on a cycle are top-level (their links do not count); blocks hanging off a cycle keep
 *   their link to the cycle member;
 * - a frame whose depth would pass FRAME_MAX_DEPTH is top-level.
 *
 * Writes (`assignParents`) never create a cycle or pass the depth: a block's own subtree is
 * excluded from its candidates.
 */

export const FRAME_TYPE = 'core.frame';
/** Frames nest at most this deep (a top-level frame has depth 1). */
export const FRAME_MAX_DEPTH = 8;
/** Height of the title strip at the top of a frame, in world units. */
export const FRAME_TITLE_HEIGHT = 32;
export const FRAME_TITLE_MAX = 200;

export function isFrame(block: { type: string } | undefined): boolean {
  return block?.type === FRAME_TYPE;
}

/** The centre of a block: what decides which frame it belongs to. */
export function centerOf(b: { x: number; y: number; w: number; h: number }): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function contains(b: BlockShape, p: Point): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

interface Resolved {
  /** The parent link that counts, or null. */
  parent: string | null;
  /** Frames: nesting depth (1 = top level). Other blocks: depth of their frame (0 = none). */
  depth: number;
}

/**
 * The frame tree of one state of the document. Cheap to create; resolves lazily and caches,
 * so create a new one after the document changed.
 */
export class FrameTree {
  private readonly resolved = new Map<string, Resolved>();
  private childIndex: Map<string, string[]> | undefined;

  constructor(private readonly board: BoardDoc) {}

  /** The parent that counts (see the module comment), or null. */
  parent(id: string): string | null {
    return this.resolve(id).parent;
  }

  /** Frames: 1 for a top-level frame, +1 per enclosing frame. Other blocks: their frame's depth. */
  depth(id: string): number {
    return this.resolve(id).depth;
  }

  /** The direct children of a frame. */
  children(id: string): string[] {
    if (!this.childIndex) {
      this.childIndex = new Map();
      for (const id of this.board.blockIds()) {
        const p = this.parent(id);
        if (p !== null) {
          const list = this.childIndex.get(p) ?? [];
          list.push(id);
          this.childIndex.set(p, list);
        }
      }
    }
    return this.childIndex.get(id) ?? [];
  }

  /** Every block inside a frame, at any depth (not the frame itself). */
  descendants(id: string): string[] {
    const out: string[] = [];
    // breadth first, using `out` itself as the queue (shift() would be linear per step)
    out.push(...this.children(id));
    for (const next of out) {
      out.push(...this.children(next)); // for-of on an array sees what is appended meanwhile
    }
    return out;
  }

  /** The frames around a block, innermost first. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    for (let p = this.parent(id); p !== null; p = this.parent(p)) {
      out.push(p);
    }
    return out;
  }

  /** How many levels of frames a block brings along: 0 for a block, 1 + deepest child frame. */
  height(id: string): number {
    if (!isFrame(this.board.blockShape(id))) {
      return 0;
    }
    return 1 + Math.max(0, ...this.children(id).map((c) => this.height(c)));
  }

  private resolve(id: string): Resolved {
    const known = this.resolved.get(id);
    if (known) {
      return known;
    }
    // walk the raw links up to something known, a missing/invalid link, or a cycle
    const chain: string[] = [];
    const onChain = new Set<string>();
    let cursor: string | null = id;
    let cycleAt = -1;
    while (cursor !== null && !this.resolved.has(cursor)) {
      if (onChain.has(cursor)) {
        cycleAt = chain.indexOf(cursor);
        break;
      }
      chain.push(cursor);
      onChain.add(cursor);
      const raw: string | null = this.board.blockShape(cursor)?.parent ?? null;
      cursor = raw !== null && isFrame(this.board.blockShape(raw)) ? raw : null;
    }
    let end = chain.length;
    if (cycleAt >= 0) {
      // the frames on the cycle are top-level
      for (const member of chain.slice(cycleAt)) {
        this.resolved.set(member, { parent: null, depth: 1 });
      }
      end = cycleAt;
    }
    for (let i = end - 1; i >= 0; i--) {
      const node = chain[i] as string;
      const raw = this.board.blockShape(node)?.parent ?? null;
      const above =
        raw !== null && isFrame(this.board.blockShape(raw)) ? this.resolved.get(raw) : undefined;
      const frame = isFrame(this.board.blockShape(node));
      if (!above || raw === null) {
        this.resolved.set(node, { parent: null, depth: frame ? 1 : 0 });
      } else if (frame && above.depth + 1 > FRAME_MAX_DEPTH) {
        this.resolved.set(node, { parent: null, depth: 1 });
      } else {
        this.resolved.set(node, { parent: raw, depth: frame ? above.depth + 1 : above.depth });
      }
    }
    return this.resolved.get(id) ?? { parent: null, depth: 0 };
  }
}

/** `ids` plus everything inside the frames among them (each id once, order kept). */
export function withDescendants(
  board: BoardDoc,
  ids: Iterable<string>,
  tree = new FrameTree(board),
): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    out.add(id);
    if (isFrame(board.blockShape(id))) {
      for (const d of tree.descendants(id)) {
        out.add(d);
      }
    }
  }
  return [...out];
}

/** The blocks of `ids` whose frame is not in `ids` too (what a move of `ids` re-homes). */
export function topLevelOf(
  board: BoardDoc,
  ids: Iterable<string>,
  tree = new FrameTree(board),
): string[] {
  const set = new Set(ids);
  return [...set].filter((id) => {
    if (!board.hasBlock(id)) {
      return false;
    }
    const p = tree.parent(id);
    return p === null || !set.has(p);
  });
}

/**
 * The frame a block belongs to at its current position: the innermost frame under its centre
 * (deepest first, then the one on top), never itself or a frame inside it, and only one that
 * still has room for the block's own frames within FRAME_MAX_DEPTH. Null for none.
 */
export function frameAt(
  board: BoardDoc,
  id: string,
  tree = new FrameTree(board),
  frames: readonly BlockShape[] = board.blockShapes().filter(isFrame),
): string | null {
  const block = board.blockShape(id);
  if (!block) {
    return null;
  }
  const center = centerOf(block);
  const own = new Set([id, ...(isFrame(block) ? tree.descendants(id) : [])]);
  const height = tree.height(id);
  let best: BlockShape | undefined;
  let bestDepth = 0;
  for (const f of frames) {
    if (own.has(f.id) || !contains(f, center)) {
      continue;
    }
    const depth = tree.depth(f.id);
    if (depth + height > FRAME_MAX_DEPTH) {
      continue;
    }
    if (!best || depth > bestDepth || (depth === bestDepth && f.z >= best.z)) {
      best = f;
      bestDepth = depth;
    }
  }
  return best?.id ?? null;
}

/**
 * Puts each block into the frame under its centre (or none), in one transaction. Called after
 * blocks were created, moved or pasted - with the moved top-level blocks only: whatever is inside
 * a moved frame travels with it and keeps its parent.
 */
export function assignParents(board: BoardDoc, ids: Iterable<string>): void {
  const list = [...ids];
  if (list.length === 0) {
    return;
  }
  // geometry and z do not change in the loop, so the frame list is read once
  const frames = board.blockShapes().filter(isFrame);
  board.transact(() => {
    for (const id of list) {
      // a fresh tree each time: an earlier assignment changes depths and subtrees
      const next = frameAt(board, id, new FrameTree(board), frames);
      const m = board.blocksMap.get(id);
      // also clears a link that does not count (dangling, on a cycle)
      if (m && (m.get('parent') ?? null) !== next) {
        m.set('parent', next);
      }
    }
  });
}

/**
 * A new or resized frame takes in what lies inside it: every block whose centre is in the frame
 * and for which the frame is now the innermost one. Blocks already in a frame inside it stay
 * there; the frame's own ancestors are never taken in.
 */
export function adoptInto(board: BoardDoc, frameId: string): void {
  const frame = board.blockShape(frameId);
  if (!frame || !isFrame(frame)) {
    return;
  }
  const tree = new FrameTree(board);
  const outside = new Set([frameId, ...tree.ancestors(frameId)]);
  const inside = board
    .blockShapes()
    .filter((b) => !outside.has(b.id) && contains(frame, centerOf(b)))
    .map((b) => b.id);
  const level = tree.parent(frameId);
  // only blocks on the frame's own level: nothing is taken out of another frame
  assignParents(
    board,
    inside.filter((id) => tree.parent(id) === level),
  );
}

/**
 * Deletes frames but keeps what is inside: their children move to the frame's own parent (or
 * the board). One transaction.
 */
export function removeFramesKeepContents(board: BoardDoc, frameIds: Iterable<string>): void {
  const frames = [...frameIds].filter((id) => isFrame(board.blockShape(id)));
  if (frames.length === 0) {
    return;
  }
  board.transact(() => {
    const removed = new Set(frames);
    for (const id of frames) {
      const tree = new FrameTree(board);
      // the nearest ancestor that is not removed as well
      const target = tree.ancestors(id).find((a) => !removed.has(a)) ?? null;
      for (const child of tree.children(id)) {
        board.blocksMap.get(child)?.set('parent', target);
      }
    }
    board.deleteItems(frames);
  });
}
