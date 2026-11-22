import type { BoardFile } from '../io/board-file.js';
import { FRAME_TYPE } from '../model/frames.js';
import { BoardTheme, displayColor } from '../theme.js';

export interface PreviewShape {
  x: number;
  y: number;
  w: number;
  h: number;
  /** A CSS colour from the palette of the board file (hex) or a fixed neutral one. */
  fill: string;
  kind: 'frame' | 'note' | 'column' | 'text';
}

export interface Preview {
  /** The viewBox is `0 0 width height`; shapes are scaled into it. */
  width: number;
  height: number;
  shapes: PreviewShape[];
}

const HEX = /^#[0-9a-f]{3,8}$/i;
const SIZE = 160;

function colorOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX.test(value) ? value : fallback;
}

/** The fill of a kanban column and the stroke of a frame, per theme. */
const COLUMN_FILL: Record<BoardTheme, string> = { light: '#e2e8f0', dark: '#334155' };

/**
 * A simplified picture of a board file for template cards: frames, notes, kanban columns and
 * text lines as flat boxes scaled to fit a 160 wide box. No text is drawn. The colours are
 * those of the board on the canvas of `theme` (see `displayColor`).
 */
export function previewOf(file: BoardFile, theme: BoardTheme = 'light'): Preview {
  const blocks = file.blocks;
  if (blocks.length === 0) {
    return { width: SIZE, height: SIZE * 0.5625, shapes: [] };
  }
  const minX = Math.min(...blocks.map((b) => b.x));
  const minY = Math.min(...blocks.map((b) => b.y));
  const maxX = Math.max(...blocks.map((b) => b.x + b.w));
  const maxY = Math.max(...blocks.map((b) => b.y + b.h));
  const scale = SIZE / Math.max(maxX - minX, (maxY - minY) / 0.5625, 1);
  const place = (b: { x: number; y: number; w: number; h: number }) => ({
    x: (b.x - minX) * scale,
    y: (b.y - minY) * scale,
    w: Math.max(b.w * scale, 1),
    h: Math.max(b.h * scale, 1),
  });
  const shapes: PreviewShape[] = [];
  for (const b of blocks) {
    const box = place(b);
    if (b.type === FRAME_TYPE) {
      shapes.push({
        ...box,
        fill: displayColor(colorOf(b.props['fill'], '#ffffff'), theme),
        kind: 'frame',
      });
    } else if (b.type === 'core.kanban') {
      const columns = Array.isArray(b.props['columns']) ? b.props['columns'].length : 3;
      const width = box.w / Math.max(columns, 1);
      for (let i = 0; i < columns; i++) {
        shapes.push({
          x: box.x + i * width + 0.5,
          y: box.y,
          w: Math.max(width - 1, 1),
          h: box.h,
          fill: COLUMN_FILL[theme],
          kind: 'column',
        });
      }
    } else if (b.type === 'core.text') {
      shapes.push({ ...box, h: Math.max(box.h * 0.35, 1.5), fill: '#94a3b8', kind: 'text' });
    } else {
      shapes.push({
        ...box,
        fill: displayColor(colorOf(b.props['color'] ?? b.props['fill'], '#fde68a'), theme),
        kind: 'note',
      });
    }
  }
  const height = Math.max((maxY - minY) * scale, 1);
  const width = Math.max((maxX - minX) * scale, 1);
  return { width, height, shapes };
}
