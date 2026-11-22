import type { Rect, Size } from '@apps/drawboard-engine';

/** Approximate height of the contextual toolbar (one row of small buttons plus padding). */
export const TOOLBAR_HEIGHT = 48;
/** Space between the selection and the toolbar. */
export const TOOLBAR_GAP = 12;
/** Keep clear of the pills at the top edge of the window. */
export const TOP_CLEARANCE = 64;
const EDGE = 8;

export interface ToolbarPlacement {
  /** Horizontal centre of the toolbar (the view clamps it so the bar stays on screen). */
  x: number;
  /** Top edge of the toolbar. */
  y: number;
  /** True when the toolbar sits below the selection instead of above. */
  below: boolean;
}

/**
 * Where the toolbar of a selection goes: centred above it, below it if there is no room above,
 * pinned inside the window if the selection is larger than the window. `undefined` when the
 * selection is entirely out of view (the toolbar hides then). A zero-sized `bounds` means the
 * window is not measured: nothing is culled.
 */
export function placeToolbar(anchor: Rect, bounds: Size): ToolbarPlacement | undefined {
  const measured = bounds.w > 0 && bounds.h > 0;
  if (
    measured &&
    (anchor.x + anchor.w < 0 ||
      anchor.x > bounds.w ||
      anchor.y + anchor.h < 0 ||
      anchor.y > bounds.h)
  ) {
    return undefined;
  }
  const x = anchor.x + anchor.w / 2;
  const above = anchor.y - TOOLBAR_GAP - TOOLBAR_HEIGHT;
  if (above >= TOP_CLEARANCE) {
    return { x, y: above, below: false };
  }
  const under = anchor.y + anchor.h + TOOLBAR_GAP;
  if (!measured || under + TOOLBAR_HEIGHT <= bounds.h - EDGE) {
    return { x, y: under, below: true };
  }
  // the selection fills the window: float at the top of the visible part
  return { x, y: Math.max(TOP_CLEARANCE, EDGE), below: false };
}
