import type { FileMeta } from '../files/file-source.js';

/*
 * The type names, default sizes and palette constants of the built-in blocks: the data side of
 * the block types, without their views. The file format (io/board-file.ts), the clipboard, the
 * templates and the tools read them from here; the views in blocks/ import them too. Frames
 * (model/frames.ts), story cards (model/story-model.ts) and kanban boards
 * (model/kanban-model.ts) keep theirs next to their models.
 */

export const STICKY_TYPE = 'core.sticky';

/** The fills a sticky note can have (the palette of the toolbars). */
export const STICKY_COLORS = [
  '#fde68a',
  '#fecdd3',
  '#bae6fd',
  '#bbf7d0',
  '#fed7aa',
  '#ddd6fe',
] as const;

export const SHAPE_TYPE = 'core.shape';

export const TEXT_TYPE = 'core.text';

export const FILE_TYPE = 'core.file';

/** Largest edge of a new image or video block in board units. */
const MAX_EDGE = 480;

/** Height of the caption bar (file name and download button) under the content. */
export const CAPTION_HEIGHT = 28;

/** Size of a new block for a file: images and videos keep their aspect ratio. */
export function fileBlockSize(file: Pick<FileMeta, 'kind' | 'width' | 'height'>): {
  w: number;
  h: number;
} {
  if ((file.kind === 'IMAGE' || file.kind === 'VIDEO') && file.width && file.height) {
    const scale = Math.min(1, MAX_EDGE / Math.max(file.width, file.height));
    return {
      w: Math.max(48, Math.round(file.width * scale)),
      h: Math.max(48, Math.round(file.height * scale)) + CAPTION_HEIGHT,
    };
  }
  switch (file.kind) {
    case 'VIDEO':
      return { w: 480, h: 270 + CAPTION_HEIGHT };
    case 'PDF':
    case 'DOCUMENT':
      return { w: 360, h: 480 };
    default:
      return { w: 320, h: 200 };
  }
}

export const MERMAID_TYPE = 'core.mermaid';

/** Largest diagram source (UTF-8 bytes) that is rendered or accepted by the editor (S5.1). */
export const MAX_MERMAID_BYTES = 50_000;

export const EMOJI_TYPE = 'core.emoji';
export const EMOJI_DEFAULT_SIZE = 64;

export const GIF_TYPE = 'core.gif';
export const GIF_DEFAULT_SIZE = { w: 240, h: 180 } as const;
