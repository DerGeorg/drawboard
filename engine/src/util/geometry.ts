import { Point, Rect } from '../model/types.js';

export function rectContains(r: Rect, p: Point, margin = 0): boolean {
  return (
    p.x >= r.x - margin &&
    p.x <= r.x + r.w + margin &&
    p.y >= r.y - margin &&
    p.y <= r.y + r.h + margin
  );
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export function unionRects(rects: Rect[]): Rect | undefined {
  if (rects.length === 0) {
    return undefined;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Bounding box of a flat `[x, y, pressure, ...]` array. */
export function pointsBounds(points: number[]): Rect {
  const pts: Rect[] = [];
  for (let i = 0; i + 1 < points.length; i += 3) {
    pts.push({ x: points[i] ?? 0, y: points[i + 1] ?? 0, w: 0, h: 0 });
  }
  return unionRects(pts) ?? { x: 0, y: 0, w: 0, h: 0 };
}

export function distanceToPolyline(p: Point, points: number[]): number {
  let best = Infinity;
  if (points.length >= 2 && points.length < 4) {
    return Math.hypot(p.x - (points[0] ?? 0), p.y - (points[1] ?? 0));
  }
  for (let i = 0; i + 4 < points.length; i += 3) {
    const a = { x: points[i] ?? 0, y: points[i + 1] ?? 0 };
    const b = { x: points[i + 3] ?? 0, y: points[i + 4] ?? 0 };
    best = Math.min(best, distanceToSegment(p, a, b));
  }
  return best;
}
