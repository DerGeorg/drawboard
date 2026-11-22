import {
  FRAME_TITLE_MAX,
  isFrame,
  parseCellProps,
  parseTableProps,
  BlockData,
  safeColor,
  BoardTheme,
  displayColor,
} from '@apps/drawboard-engine';
import { BlockType, BlockView } from './block-registry';

/**
 * Below this zoom every block is drawn as a plain coloured box (level of detail): no text
 * layout, no plugin frames, no images, PDFs or diagrams - at 2 % a sticky note is 4 px wide and
 * a board of thousands of blocks must stay smooth. Frames keep their title.
 */
export const SIMPLE_ZOOM = 0.15;
/**
 * Back to the full views only above this zoom: zooming around SIMPLE_ZOOM must not remount every
 * block on each wheel tick.
 */
export const FULL_ZOOM = 0.18;

/** The box of a block whose type gives no colour (plugins, files, diagrams, text). */
export const SIMPLE_NEUTRAL = '#e2e8f0';
/** The neutral box on the dark canvas. */
export const SIMPLE_NEUTRAL_DARK = '#334155';
const FRAME_BORDER = '#94a3b8';

/**
 * The world element carries `--be-inv-zoom` (1 / zoom): lengths multiplied by it have the same
 * size on screen at every zoom (frame borders and titles).
 */
export const INV_ZOOM_VAR = '--be-inv-zoom';
const SCREEN_PX = `var(${INV_ZOOM_VAR}, 1)`;

/** Whether the renderer draws simple boxes at `zoom`, given what it draws now (hysteresis). */
export function simpleAt(zoom: number, simpleNow: boolean): boolean {
  return simpleNow ? zoom < FULL_ZOOM : zoom < SIMPLE_ZOOM;
}

/**
 * The fill of a simple box: the type's colour (trusted types only), always through safeColor,
 * mapped for the theme like the full view (`displayColor`; the document keeps its colours).
 */
export function simpleFillOf(
  type: BlockType | undefined,
  block: BlockData,
  theme: BoardTheme = 'light',
): string {
  const neutral = theme === 'dark' ? SIMPLE_NEUTRAL_DARK : SIMPLE_NEUTRAL;
  if (!type?.trusted || !type.simpleFill) {
    return neutral;
  }
  let fill: unknown;
  try {
    fill = type.simpleFill(block);
  } catch {
    fill = undefined;
  }
  return fill === 'transparent' ? 'transparent' : displayColor(safeColor(fill, neutral), theme);
}

/**
 * One element per block and no children - except a frame's title, which stays readable at a
 * fixed screen size above the frame (Miro does the same). Text only through `textContent`.
 */
export function renderSimple(
  host: HTMLElement,
  block: BlockData,
  fillOf: (block: BlockData) => string,
  titleOf: (block: BlockData) => string,
): BlockView {
  const doc = host.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'be-simple';
  box.style.cssText = 'width:100%;height:100%;box-sizing:border-box';
  host.appendChild(box);
  let title: HTMLElement | undefined;
  const apply = (b: BlockData): void => {
    box.style.background = fillOf(b);
    const frame = isFrame(b);
    const cell = frame && parseCellProps(b.props['cell']) !== undefined;
    // a frame (not a table cell) gets an outline of one screen pixel and its title
    box.style.border = frame && !cell ? `calc(1px * ${SCREEN_PX}) solid ${FRAME_BORDER}` : '0';
    if (frame && !cell) {
      if (!title) {
        title = doc.createElement('div');
        title.className = 'be-simple-title';
        title.style.cssText =
          'position:absolute;left:0;bottom:100%;max-width:100%;overflow:hidden;white-space:nowrap;' +
          `text-overflow:ellipsis;font:600 calc(12px * ${SCREEN_PX})/1.4 system-ui,sans-serif;` +
          `color:var(--be-text-2,#475569);padding-bottom:calc(2px * ${SCREEN_PX})`;
        host.appendChild(title);
      }
      const fallback = parseTableProps(b.props['table']) ? 'Table' : 'Frame';
      title.textContent = titleOf(b).slice(0, FRAME_TITLE_MAX) || fallback;
    } else if (title) {
      title.remove();
      title = undefined;
    }
  };
  apply(block);
  return {
    update: apply,
    destroy: () => {
      box.remove();
      title?.remove();
    },
  };
}
