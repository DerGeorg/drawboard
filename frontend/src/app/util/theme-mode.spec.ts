import {
  THEME_STORAGE_KEY,
  applyStoredTheme,
  applyThemeAttribute,
  parseThemeMode,
  readStoredTheme,
  storeTheme,
} from './theme-mode';

describe('theme-mode', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });
  afterEach(() => vi.restoreAllMocks());

  describe('parseThemeMode', () => {
    it('when the value is one of the three modes then it is that mode', () => {
      expect(parseThemeMode('SYSTEM'), 'system').toBe('SYSTEM');
      expect(parseThemeMode('LIGHT'), 'light').toBe('LIGHT');
      expect(parseThemeMode('DARK'), 'dark').toBe('DARK');
    });

    it('when the value is anything else then there is no mode', () => {
      for (const value of ['dark', 'AUTO', '', null, undefined, 3, {}]) {
        expect(parseThemeMode(value), String(value)).toBeUndefined();
      }
    });
  });

  describe('readStoredTheme and storeTheme', () => {
    it('when a mode was stored then it is read back from the one key', () => {
      storeTheme('DARK');

      expect(window.localStorage.getItem(THEME_STORAGE_KEY), 'stored value').toBe('DARK');
      expect(readStoredTheme(), 'read value').toBe('DARK');
    });

    it('when the stored value is invalid then it is dropped', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');

      expect(readStoredTheme(), 'invalid value').toBeUndefined();
    });

    it('when nothing is stored then there is no mode', () => {
      expect(readStoredTheme(), 'empty storage').toBeUndefined();
    });

    it('when reading the storage throws then there is no mode and nothing is thrown', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });

      expect(readStoredTheme(), 'blocked storage').toBeUndefined();
    });

    it('when writing the storage throws then the choice is ignored without an error', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });

      expect(() => storeTheme('LIGHT'), 'blocked storage').not.toThrow();
    });

    it('when the browser refuses to hand out the storage then nothing is thrown either', () => {
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new Error('SecurityError');
      });

      expect(readStoredTheme(), 'read').toBeUndefined();
      expect(() => storeTheme('DARK'), 'write').not.toThrow();
    });
  });

  describe('applyThemeAttribute', () => {
    it('when the mode is fixed then data-theme is light or dark, and System removes it', () => {
      const root = document.documentElement;

      applyThemeAttribute(root, 'DARK');
      expect(root.dataset['theme'], 'dark').toBe('dark');
      applyThemeAttribute(root, 'LIGHT');
      expect(root.dataset['theme'], 'light').toBe('light');
      applyThemeAttribute(root, 'SYSTEM');
      expect(root.dataset['theme'], 'system').toBeUndefined();
    });
  });

  describe('applyStoredTheme', () => {
    it('when a mode is cached then the attribute is set before the app starts', () => {
      storeTheme('DARK');

      applyStoredTheme();

      expect(document.documentElement.dataset['theme'], 'attribute').toBe('dark');
    });

    it('when nothing valid is cached then the attribute stays off', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'nope');

      applyStoredTheme();

      expect(document.documentElement.dataset['theme'], 'attribute').toBeUndefined();
    });
  });
});
