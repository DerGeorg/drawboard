/**
 * The theme of the board surface: how the drawing is shown, never how it is stored.
 *
 * The colours of the content (ink, fills, sticky colours) are written into the document and are
 * the same for every participant, whatever theme they look at the board in. Only the display is
 * mapped (`displayColor`): the default ink and white fills would vanish on a dark canvas. The
 * chrome of the blocks (card backgrounds, borders, text) reads CSS variables that the renderer
 * sets on the board container for the current theme (`BOARD_THEME_VARS`).
 */
export type BoardTheme = 'light' | 'dark';

export const BOARD_THEMES: readonly BoardTheme[] = ['light', 'dark'];

/** The default ink of pen, shapes, connectors and text (the first colour of STROKE_COLORS). */
export const DEFAULT_INK = '#0f172a';
/** What the default ink looks like on the dark canvas. */
export const DARK_INK = '#e2e8f0';
/** The default fill of shapes, frames and table cells. */
export const DEFAULT_PAPER = '#ffffff';
/** What a default (white) fill looks like on the dark canvas. */
export const DARK_PAPER = '#1e293b';
/** The fill of a table's header row (model/tables.ts). */
const TABLE_HEADER = '#f1f5f9';
const DARK_TABLE_HEADER = '#334155';

/** Dark neutral inks that were the default of connectors and borders; shown light on dark. */
const INK_COLORS: ReadonlyMap<string, string> = new Map([
  [DEFAULT_INK, DARK_INK],
  ['#334155', '#cbd5e1'],
  ['#000000', DARK_INK],
  ['#000', DARK_INK],
]);

const PAPER_COLORS: ReadonlyMap<string, string> = new Map([
  [DEFAULT_PAPER, DARK_PAPER],
  ['#fff', DARK_PAPER],
  [TABLE_HEADER, DARK_TABLE_HEADER],
]);

/**
 * The colour a stored content colour is drawn in. Light theme: unchanged. Dark theme: the
 * default ink (and its neighbours) is drawn light, a white fill dark; `transparent`, pastel
 * fills, sticky colours and every other colour stay as they are. Pure; the document is never
 * touched.
 */
export function displayColor(color: string, theme: BoardTheme): string {
  if (theme !== 'dark') {
    return color;
  }
  const key = color.toLowerCase();
  return INK_COLORS.get(key) ?? PAPER_COLORS.get(key) ?? color;
}

/**
 * True when the fill is drawn in a theme colour on the dark canvas (white, the table header,
 * no fill): text on it follows the theme. On any other fill (pastel, colour) the text stays
 * dark, because those fills stay light.
 */
export function isThemedFill(fill: unknown): boolean {
  if (typeof fill !== 'string' || fill === 'none') {
    return true;
  }
  const key = fill.toLowerCase();
  return key === 'transparent' || PAPER_COLORS.has(key);
}

/** Dark text on the fills that stay light; used where text sits on a content colour. */
export const TEXT_ON_PASTEL = '#1f2937';

/** True on the dark canvas for a fill that is NOT remapped (pastel, colour): text stays dark. */
export function fillStaysLight(fill: unknown, theme: BoardTheme): boolean {
  return theme === 'dark' && !isThemedFill(fill);
}

/** The CSS variables of the board chrome per theme (set on the container by the renderer). */
export const BOARD_THEME_VARS: Readonly<Record<BoardTheme, Readonly<Record<string, string>>>> = {
  light: {
    '--be-grid-dot': 'rgba(15, 23, 42, 0.28)',
    '--be-selection': '#2563eb',
    '--be-text': '#1f2937',
    '--be-text-2': '#475569',
    '--be-text-3': '#64748b',
    '--be-text-strong': '#334155',
    '--be-surface': '#ffffff',
    '--be-surface-2': '#f8fafc',
    '--be-surface-3': '#e9eef5',
    '--be-border': '#cbd5e1',
    '--be-border-soft': '#e2e8f0',
    '--be-chip': '#e2e8f0',
    '--be-avatar': '#1e293b',
    '--be-hover': 'rgba(15, 23, 42, 0.08)',
    '--be-danger': '#b91c1c',
    '--be-story-kind': '#0f766e',
    '--be-story-chip': '#ccfbf1',
    '--be-story-chip-text': '#134e4a',
    '--be-editor-bg': 'rgba(255, 255, 255, 0.55)',
    '--be-editor-text': '#1f2937',
    '--be-pdf-bg': '#f1f5f9',
  },
  dark: {
    '--be-grid-dot': 'rgba(226, 232, 240, 0.3)',
    '--be-selection': '#60a5fa',
    '--be-text': '#e2e8f0',
    '--be-text-2': '#cbd5e1',
    '--be-text-3': '#94a3b8',
    '--be-text-strong': '#e2e8f0',
    '--be-surface': '#1e293b',
    '--be-surface-2': '#172033',
    '--be-surface-3': '#0f1a2e',
    '--be-border': '#334155',
    '--be-border-soft': '#334155',
    '--be-chip': '#334155',
    '--be-avatar': '#475569',
    '--be-hover': 'rgba(226, 232, 240, 0.12)',
    '--be-danger': '#f87171',
    '--be-story-kind': '#5eead4',
    '--be-story-chip': '#134e4a',
    '--be-story-chip-text': '#ccfbf1',
    '--be-editor-bg': 'rgba(15, 23, 42, 0.6)',
    '--be-editor-text': '#e2e8f0',
    '--be-pdf-bg': '#0f172a',
  },
};

/** Narrows an untrusted value (a stored choice, a plugin message) to a theme. */
export function parseBoardTheme(value: unknown): BoardTheme | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}
