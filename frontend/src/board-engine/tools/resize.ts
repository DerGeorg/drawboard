import { MIN_BLOCK_SIZE, Point, Rect } from '../model/types';
import { HandleId } from './tool';

export const HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Position of a handle on a rectangle (any coordinate space). */
export function handlePosition(r: Rect, h: HandleId): Point {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

export function handleCursor(h: HandleId): string {
  return h === 'n' || h === 's'
    ? 'ns-resize'
    : h === 'e' || h === 'w'
      ? 'ew-resize'
      : h === 'nw' || h === 'se'
        ? 'nwse-resize'
        : 'nesw-resize';
}

/**
 * The rectangle after dragging `handle` by (dx, dy) world units. The opposite side stays fixed.
 * `keepAspect` (corner handles) keeps the initial ratio. Never smaller than MIN_BLOCK_SIZE.
 */
export function resizeRect(
  initial: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  keepAspect = false,
): Rect {
  let { w, h } = initial;
  if (handle.includes('e')) {
    w = initial.w + dx;
  }
  if (handle.includes('w')) {
    w = initial.w - dx;
  }
  if (handle.includes('s')) {
    h = initial.h + dy;
  }
  if (handle.includes('n')) {
    h = initial.h - dy;
  }
  if (keepAspect && handle.length === 2 && initial.w > 0 && initial.h > 0) {
    const ratio = initial.w / initial.h;
    if (Math.abs(w / initial.w) > Math.abs(h / initial.h)) {
      h = w / ratio;
    } else {
      w = h * ratio;
    }
  }
  w = Math.max(MIN_BLOCK_SIZE, w);
  h = Math.max(MIN_BLOCK_SIZE, h);
  const x = handle.includes('w') ? initial.x + initial.w - w : initial.x;
  const y = handle.includes('n') ? initial.y + initial.h - h : initial.y;
  return { x, y, w, h };
}
