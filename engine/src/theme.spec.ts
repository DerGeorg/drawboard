import { STROKE_COLORS } from './palette.js';
import {
  BOARD_THEME_VARS,
  DARK_INK,
  DARK_PAPER,
  displayColor,
  fillStaysLight,
  isThemedFill,
  parseBoardTheme,
} from './theme.js';

describe('board theme', () => {
  describe('displayColor', () => {
    it('when the theme is light then every colour is shown as stored', () => {
      for (const color of ['#0f172a', '#ffffff', 'transparent', '#fde68a', '#334155']) {
        expect(displayColor(color, 'light'), color).toBe(color);
      }
    });

    it('when the theme is dark then the default ink is shown light', () => {
      expect(displayColor(STROKE_COLORS[0], 'dark'), 'default ink').toBe(DARK_INK);
      expect(displayColor('#0F172A', 'dark'), 'upper case').toBe(DARK_INK);
      expect(displayColor('#334155', 'dark'), 'default connector colour').toBe('#cbd5e1');
    });

    it('when the theme is dark then a white fill is shown dark', () => {
      expect(displayColor('#ffffff', 'dark'), 'white').toBe(DARK_PAPER);
      expect(displayColor('#fff', 'dark'), 'short white').toBe(DARK_PAPER);
      expect(displayColor('#f1f5f9', 'dark'), 'table header').toBe('#334155');
    });

    it('when the theme is dark then transparent, pastel fills and colours stay as they are', () => {
      for (const color of [
        'transparent',
        '#fde68a',
        '#fecdd3',
        '#bae6fd',
        '#bbf7d0',
        '#ddd6fe',
        '#dc2626',
        '#2563eb',
        '#abcdef',
      ]) {
        expect(displayColor(color, 'dark'), color).toBe(color);
      }
    });
  });

  describe('fills and text', () => {
    it('when a fill is white, transparent or missing then it is a themed fill', () => {
      for (const fill of ['#ffffff', 'transparent', 'none', undefined, '#f1f5f9']) {
        expect(isThemedFill(fill), String(fill)).toBe(true);
      }
      expect(isThemedFill('#fde68a'), 'pastel').toBe(false);
    });

    it('when the canvas is dark then only a pastel or coloured fill keeps its dark text', () => {
      expect(fillStaysLight('#fde68a', 'dark'), 'pastel on dark').toBe(true);
      expect(fillStaysLight('#ffffff', 'dark'), 'white on dark').toBe(false);
      expect(fillStaysLight('#fde68a', 'light'), 'pastel on light').toBe(false);
    });
  });

  describe('variables', () => {
    it('when both themes are defined then they set the same variables', () => {
      expect(Object.keys(BOARD_THEME_VARS.dark).sort(), 'dark names').toEqual(
        Object.keys(BOARD_THEME_VARS.light).sort(),
      );
    });
  });

  describe('parseBoardTheme', () => {
    it('when the value is light or dark then it is a theme, anything else is not', () => {
      expect(parseBoardTheme('dark'), 'dark').toBe('dark');
      expect(parseBoardTheme('light'), 'light').toBe('light');
      expect(parseBoardTheme('DARK'), 'upper case').toBeUndefined();
      expect(parseBoardTheme(undefined), 'undefined').toBeUndefined();
    });
  });
});
