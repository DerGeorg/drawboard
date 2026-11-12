import { safeColor } from '../presence';
import { BlockType } from '../renderer/block-registry';
import { fitFontSize } from '../util/fit-text';
import { renderSafeText } from '../util/safe-text';

export const STICKY_COLORS = [
  '#fde68a',
  '#fecdd3',
  '#bae6fd',
  '#bbf7d0',
  '#fed7aa',
  '#ddd6fe',
] as const;

export const STICKY_TYPE = 'core.sticky';

/** The text starts at the large size and steps down until it fits; it never overflows. */
export const STICKY_FONT_MAX = 32;
export const STICKY_FONT_MIN = 10;
const STICKY_FONT_STEP = 2;

/** A square paper note with plain text; the text shrinks to fit the note. */
export const stickyBlock: BlockType = {
  type: STICKY_TYPE,
  label: 'Sticky note',
  defaultSize: { w: 200, h: 200 },
  defaultProps: { color: STICKY_COLORS[0] },
  textEditable: true,
  simpleFill: (block) => safeColor(block.props['color'], STICKY_COLORS[0]),
  render(host, ctx) {
    const note = host.ownerDocument.createElement('div');
    note.className = 'be-text be-sticky';
    note.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;padding:12px;overflow:hidden;white-space:pre-wrap;' +
      'overflow-wrap:anywhere;line-height:1.35;font-family:system-ui,sans-serif;color:#1f2937;' +
      'border-radius:2px;box-shadow:0 1px 1px rgba(15,23,42,.1),0 10px 18px -6px rgba(15,23,42,.28)';
    host.appendChild(note);

    /** Largest size at which the text fits the note (content height and width within the box). */
    const fit = (): void => {
      const size = fitFontSize(
        (px) => {
          note.style.fontSize = `${px}px`;
          return note.scrollHeight <= note.clientHeight && note.scrollWidth <= note.clientWidth;
        },
        STICKY_FONT_MAX,
        STICKY_FONT_MIN,
        STICKY_FONT_STEP,
      );
      note.style.fontSize = `${size}px`;
      // the text editor lays a textarea over the note and reads the size from here
      host.style.setProperty('--be-font-size', `${size}px`);
    };
    const apply = (color: unknown, text: string): void => {
      // props come from any editor of the board: only a plain hex colour reaches the style
      // (a `url(...)` here would make every viewer load a foreign image)
      note.style.background = safeColor(color, STICKY_COLORS[0]);
      renderSafeText(note, text);
      fit();
    };
    apply(ctx.block.props['color'], ctx.text());
    return {
      update: (block) => apply(block.props['color'], ctx.text()),
      mounted: fit,
      destroy: () => note.remove(),
    };
  },
};
