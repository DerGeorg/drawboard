import {
  EMOJI_DEFAULT_SIZE,
  EMOJI_TYPE,
  BlockData,
  EMOJI_FALLBACK,
  isValidEmoji,
} from '@apps/drawboard-engine';
import { BlockType } from '../renderer/block-registry';

/** The glyph fills this share of the smaller side of the block. */
const GLYPH_SHARE = 0.78;
/** The glyph never gets bigger than this in block space (zoom is a transform, not a font size). */
export const MAX_EMOJI_PX = 2048;

/** The font stack of the system's emoji fonts; no emoji graphics ship with the app (3.13). */
const EMOJI_FONTS = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/** The font size at which an emoji fills a block of this size. */
export function emojiFontSize(w: number, h: number): number {
  return Math.max(1, Math.min(w, h, MAX_EMOJI_PX) * GLYPH_SHARE);
}

/** One emoji as a stamp: drawn as text by the system's emoji font, the size follows the block. */
export const emojiBlock: BlockType = {
  type: EMOJI_TYPE,
  label: 'Emoji',
  defaultSize: { w: EMOJI_DEFAULT_SIZE, h: EMOJI_DEFAULT_SIZE },
  defaultProps: { emoji: '👍' },
  // far out the stamp is a warm dot, like a face
  simpleFill: () => '#fcd34d',
  render(host, ctx) {
    const el = host.ownerDocument.createElement('div');
    el.className = 'be-emoji';
    el.style.cssText =
      'width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;' +
      `line-height:1;white-space:nowrap;unicode-bidi:isolate;user-select:none;font-family:${EMOJI_FONTS}`;
    el.setAttribute('role', 'img');
    host.appendChild(el);
    const apply = (block: BlockData): void => {
      const value = block.props['emoji'];
      // from any editor of the board: text only (never markup), and only if it is an emoji
      el.textContent = isValidEmoji(value) ? value : EMOJI_FALLBACK;
      el.style.fontSize = `${emojiFontSize(block.w, block.h)}px`;
    };
    apply(ctx.block);
    return { update: apply, destroy: () => el.remove() };
  },
};
