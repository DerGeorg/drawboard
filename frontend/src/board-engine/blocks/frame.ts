import {
  FRAME_TITLE_HEIGHT,
  FRAME_TITLE_MAX,
  FRAME_TYPE,
  parseCellProps,
  parseTableProps,
  safeColor,
  displayColor,
  fillStaysLight,
} from '@apps/drawboard-engine';
import { BlockType } from '../renderer/block-registry';
import { setEditorColors } from '../renderer/editor-colors';
import { renderSafeText } from '../util/safe-text';

export { FRAME_TYPE } from '@apps/drawboard-engine';

/** A frame's fill when none (or no valid one) is set. */
export const FRAME_DEFAULT_FILL = '#ffffff';

/**
 * Only a plain hex colour or `transparent` reaches the style (S5.2): props come from any editor
 * of the board, and a `url(...)` here would make every viewer load a foreign image.
 */
export function frameFill(value: unknown): string {
  return value === 'transparent' ? 'transparent' : safeColor(value, FRAME_DEFAULT_FILL);
}

/**
 * `core.frame`: an area with a title that holds other blocks (their `parent` is the frame, see
 * `model/frames.ts`). The engine draws frames in their own layer below every other block, a
 * nested frame above the one around it. The title is the block's text (edited in place,
 * one line, at most 200 characters); the fill is a palette colour (`fill`, through
 * `safeColor`). A table (`props.table`) and its cells (`props.cell`, model/tables.ts) are frames
 * too and only look different: a cell has thin grid lines, the header row a bold title.
 */
export const frameBlock: BlockType = {
  type: FRAME_TYPE,
  label: 'Frame',
  defaultSize: { w: 640, h: 400 },
  defaultProps: { fill: FRAME_DEFAULT_FILL },
  textEditable: true,
  textMaxLength: FRAME_TITLE_MAX,
  simpleFill: (block) => frameFill(block.props['fill']),
  render(host, ctx) {
    const doc = host.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'be-frame';
    box.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;border:1px solid var(--be-border,#cbd5e1);border-radius:6px;' +
      'box-shadow:0 1px 2px rgba(15,23,42,.08)';
    // the strip the text editor opens in (data-be-text-host) and where a drag moves the frame
    const strip = doc.createElement('div');
    strip.dataset['beTextHost'] = '';
    strip.style.cssText = `position:relative;height:${FRAME_TITLE_HEIGHT}px;box-sizing:border-box`;
    const title = doc.createElement('div');
    title.className = 'be-text be-frame-title';
    title.style.cssText =
      'height:100%;box-sizing:border-box;padding:7px 10px 0;overflow:hidden;white-space:nowrap;' +
      'text-overflow:ellipsis;font:600 13px/18px system-ui,sans-serif;color:var(--be-text-2,#475569)';
    strip.appendChild(title);
    box.appendChild(strip);
    host.appendChild(box);
    const apply = (props: Record<string, unknown>): void => {
      // the look only; whether a table is intact is decided where it matters (model/tables.ts)
      const cell = parseCellProps(props['cell']);
      const table = parseTableProps(props['table']);
      const theme = ctx.theme();
      const fill = frameFill(props['fill']);
      box.style.background = displayColor(fill, theme);
      // the title sits on the frame: on a fill that stays light on the dark canvas it stays dark
      const light = fillStaysLight(fill, theme);
      box.style.borderRadius = cell ? '0' : '6px';
      box.style.boxShadow = cell ? 'none' : '0 1px 2px rgba(15,23,42,.08)';
      box.style.border = cell ? '0' : '1px solid var(--be-border, #cbd5e1)';
      if (cell) {
        // neighbouring cells share one line
        box.style.borderRight = box.style.borderBottom = '1px solid var(--be-border, #cbd5e1)';
      }
      title.style.fontWeight = !cell || cell.row === 0 ? '600' : '400';
      const body = cell !== undefined && cell.row > 0;
      title.style.color = light
        ? body
          ? '#64748b'
          : '#475569'
        : body
          ? 'var(--be-text-3, #64748b)'
          : 'var(--be-text-2, #475569)';
      setEditorColors(box, light);
      if (cell) {
        box.dataset['cell'] = `${cell.row},${cell.col}`;
      } else {
        delete box.dataset['cell'];
      }
      const fallback = cell ? '' : table ? 'Table' : 'Frame';
      renderSafeText(title, ctx.text().slice(0, FRAME_TITLE_MAX) || fallback);
    };
    apply(ctx.block.props);
    return {
      update: (block) => apply(block.props),
      destroy: () => box.remove(),
    };
  },
};
