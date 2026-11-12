import { Camera } from './camera';

/** Distance of the dots in world units at zoom 1. */
export const GRID_SPACING = 24;
/** The dots stay between these screen distances: far out every second dot goes, close in they double. */
const MIN_SCREEN_SPACING = 18;
const MAX_SCREEN_SPACING = 36;
/** Far out the dots fade (full colour down to this zoom) ... */
export const GRID_FADE_FROM = 0.15;
/** ... and are gone below this one: no background to paint while a huge area is in view. */
export const GRID_HIDDEN_BELOW = 0.06;

export interface GridStyle {
  /** Tile size in screen pixels (one dot per tile). */
  size: number;
  /** Where the tile starts so that a dot sits on every grid line of the world. */
  x: number;
  y: number;
  /** Dot radius in screen pixels. */
  dot: number;
  /** 1 = full dot colour, 0 = no grid at all (far zoomed out). */
  alpha: number;
}

/** How visible the dots are at `zoom`: 1 down to GRID_FADE_FROM, then linear to 0. */
export function gridAlpha(zoom: number): number {
  if (zoom >= GRID_FADE_FROM) {
    return 1;
  }
  if (zoom < GRID_HIDDEN_BELOW) {
    return 0;
  }
  return (
    Math.round(((zoom - GRID_HIDDEN_BELOW) / (GRID_FADE_FROM - GRID_HIDDEN_BELOW)) * 100) / 100
  );
}

/**
 * The dot grid as one tiled CSS background: no element per dot, the browser repeats the tile.
 * The grid lives in world space, so it pans and scales with the camera; the density adapts so
 * the dots neither blur into a grey area nor drift apart.
 */
export function gridStyle(camera: Camera): GridStyle {
  let size = GRID_SPACING * camera.zoom;
  while (size < MIN_SCREEN_SPACING) {
    size *= 2;
  }
  while (size >= MAX_SCREEN_SPACING) {
    size /= 2;
  }
  const dot = Math.min(1.6, Math.max(0.9, camera.zoom * 1.1));
  // the dot is the centre of its tile, a world grid point is a tile corner: shift by half a tile
  return {
    size,
    x: camera.x - size / 2,
    y: camera.y - size / 2,
    dot,
    alpha: gridAlpha(camera.zoom),
  };
}

/**
 * Paints the grid on `el` (the colour comes from the CSS variable `--be-grid-dot`); far zoomed
 * out the dots fade and then the background is dropped.
 */
export function applyGrid(el: HTMLElement, camera: Camera): void {
  const g = gridStyle(camera);
  const s = el.style;
  if (g.alpha <= 0) {
    s.backgroundImage = 'none';
    return;
  }
  const dot = 'var(--be-grid-dot, rgba(15, 23, 42, 0.28))';
  const color =
    g.alpha >= 1 ? dot : `color-mix(in srgb, ${dot} ${Math.round(g.alpha * 100)}%, transparent)`;
  s.backgroundImage = `radial-gradient(circle, ${color} ${g.dot}px, transparent ${g.dot + 0.4}px)`;
  s.backgroundSize = `${g.size}px ${g.size}px`;
  s.backgroundPosition = `${g.x}px ${g.y}px`;
}
