import { Point, Rect, Size } from './model/types';

/** `screen = world * zoom + (x, y)`: x and y are where the world origin appears on screen. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** 2 %: a whole workshop board fits on one screen (Miro goes as far). */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

export const INITIAL_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(c: Camera, p: Point): Point {
  return { x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom };
}

export function worldToScreen(c: Camera, p: Point): Point {
  return { x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y };
}

/** Zooms by `factor` keeping the world point under `screen` fixed. */
export function zoomAt(c: Camera, screen: Point, factor: number): Camera {
  const zoom = clampZoom(c.zoom * factor);
  const world = screenToWorld(c, screen);
  return { zoom, x: screen.x - world.x * zoom, y: screen.y - world.y * zoom };
}

export function setZoomAt(c: Camera, screen: Point, zoom: number): Camera {
  return zoomAt(c, screen, clampZoom(zoom) / c.zoom);
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, x: c.x + dx, y: c.y + dy };
}

/** The world rectangle visible in a viewport of the given size. */
export function visibleWorldRect(c: Camera, viewport: Size): Rect {
  return { x: -c.x / c.zoom, y: -c.y / c.zoom, w: viewport.w / c.zoom, h: viewport.h / c.zoom };
}

/** A camera that shows `content` centered with `padding` screen pixels around (zoom <= 1 or max 1.5). */
export function fitToRect(content: Rect, viewport: Size, padding = 48): Camera {
  if (content.w <= 0 && content.h <= 0) {
    return { x: viewport.w / 2 - content.x, y: viewport.h / 2 - content.y, zoom: 1 };
  }
  const availW = Math.max(1, viewport.w - padding * 2);
  const availH = Math.max(1, viewport.h - padding * 2);
  const zoom = clampZoom(
    Math.min(availW / Math.max(content.w, 1), availH / Math.max(content.h, 1), 1.5),
  );
  return {
    zoom,
    x: viewport.w / 2 - (content.x + content.w / 2) * zoom,
    y: viewport.h / 2 - (content.y + content.h / 2) * zoom,
  };
}

/** Time constant of a glide (following someone): about 90 % of the way in 0.25 s. */
const GLIDE_TAU_MS = 110;

/**
 * One step of a smooth camera move towards `target` after `dtMs`: exponential approach, the
 * zoom in log space (zooming feels even), the centre of the view moving in world space. Returns
 * `target` itself once the remaining distance is below half a pixel.
 */
export function glideCamera(from: Camera, target: Camera, dtMs: number, viewport: Size): Camera {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / GLIDE_TAU_MS);
  const cx = viewport.w / 2;
  const cy = viewport.h / 2;
  const a = screenToWorld(from, { x: cx, y: cy });
  const b = screenToWorld(target, { x: cx, y: cy });
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(target.zoom) - Math.log(from.zoom)) * k);
  const center = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  const next = { zoom, x: cx - center.x * zoom, y: cy - center.y * zoom };
  const close =
    Math.abs(next.x - target.x) < 0.5 &&
    Math.abs(next.y - target.y) < 0.5 &&
    Math.abs(next.zoom - target.zoom) < target.zoom * 0.001;
  return close ? target : next;
}
