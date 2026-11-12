import { BoardDoc } from './model/board-doc';
import { FrameTree, isFrame } from './model/frames';
import { ConnectorData, Point, Rect } from './model/types';
import { HitResult } from './tools/tool';
import {
  distanceToPolyline,
  distanceToSegment,
  pointsBounds,
  rectContains,
  rectsIntersect,
} from './util/geometry';

/** Where a connector is drawn: both resolved end points, or undefined if an end block is gone. */
export function connectorEndpoints(board: BoardDoc, c: ConnectorData): [Point, Point] | undefined {
  const centerOf = (end: ConnectorData['from']): Point | undefined => {
    if ('block' in end) {
      const b = board.getBlock(end.block);
      return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : undefined;
    }
    return end;
  };
  const fromCenter = centerOf(c.from);
  const toCenter = centerOf(c.to);
  if (!fromCenter || !toCenter) {
    return undefined;
  }
  const from = board.resolveEnd(c.from, toCenter);
  const to = board.resolveEnd(c.to, fromCenter);
  return from && to ? [from, to] : undefined;
}

/** World bounding box of a block, connector or stroke. */
export function itemBounds(board: BoardDoc, id: string): Rect | undefined {
  const b = board.getBlock(id);
  if (b) {
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }
  const s = board.getStroke(id);
  if (s) {
    const r = pointsBounds(s.points);
    const pad = s.style.size / 2;
    return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  }
  const c = board.getConnector(id);
  const ends = c && connectorEndpoints(board, c);
  if (ends) {
    const [a, z] = ends;
    return {
      x: Math.min(a.x, z.x),
      y: Math.min(a.y, z.y),
      w: Math.abs(a.x - z.x),
      h: Math.abs(a.y - z.y),
    };
  }
  return undefined;
}

/**
 * Top-most block under the point, in the order they are painted: any other block above every
 * frame, a nested frame above the frame around it, then the highest z.
 */
export function blockAt(board: BoardDoc, p: Point): string | undefined {
  let best: { id: string; layer: number; z: number } | undefined;
  let tree: FrameTree | undefined;
  for (const b of board.blocks()) {
    if (!rectContains(b, p)) {
      continue;
    }
    let layer = Number.MAX_SAFE_INTEGER;
    if (isFrame(b)) {
      tree ??= new FrameTree(board);
      layer = tree.depth(b.id);
    }
    if (!best || layer > best.layer || (layer === best.layer && b.z >= best.z)) {
      best = { id: b.id, layer, z: b.z };
    }
  }
  return best?.id;
}

/**
 * Strokes first (they are drawn on top), then connectors, then blocks.
 * `tolerance` is in world units (screen tolerance / zoom).
 */
export function hitTest(board: BoardDoc, p: Point, tolerance: number): HitResult | undefined {
  for (const s of board.strokes().reverse()) {
    if (distanceToPolyline(p, s.points) <= tolerance + s.style.size / 2) {
      return { kind: 'stroke', id: s.id };
    }
  }
  for (const c of board.connectors()) {
    const ends = connectorEndpoints(board, c);
    if (ends && distanceToSegment(p, ends[0], ends[1]) <= tolerance + c.style.width / 2) {
      return { kind: 'connector', id: c.id };
    }
  }
  const id = blockAt(board, p);
  return id ? { kind: 'block', id } : undefined;
}

/**
 * Every item whose bounding box touches `rect`; a frame only when it lies inside `rect`
 * completely (a marquee drawn inside a frame selects what is in it, not the frame).
 */
export function itemsInRect(board: BoardDoc, rect: Rect): string[] {
  const ids = [...board.blockIds(), ...board.strokeIds(), ...board.connectorIds()];
  return ids.filter((id) => {
    const r = itemBounds(board, id);
    if (r === undefined) {
      return false;
    }
    return isFrame(board.getBlock(id)) ? rectInside(r, rect) : rectsIntersect(r, rect);
  });
}

function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}
