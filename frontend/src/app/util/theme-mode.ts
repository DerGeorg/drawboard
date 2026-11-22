import type { ColorTheme } from '@apps/drawboard-api';

/** The user's choice: follow the system or fix light or dark (the API's `ColorTheme`). */
export type ThemeMode = ColorTheme;

/** What is drawn: `SYSTEM` is resolved to one of these. */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['SYSTEM', 'LIGHT', 'DARK'];

/** The one localStorage key: a cache of the choice, so the first paint already has it. */
export const THEME_STORAGE_KEY = 'drawboard.theme';

/** Narrows an untrusted value (storage, the server) to a mode. */
export function parseThemeMode(value: unknown): ThemeMode | undefined {
  return THEME_MODES.find((mode) => mode === value);
}

/** The storage, or undefined where the browser refuses it (private window, blocked site data). */
function storageOf(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The cached choice; nothing for a missing, unreadable or invalid entry. Never throws. */
export function readStoredTheme(storage: Storage | undefined = storageOf()): ThemeMode | undefined {
  try {
    return parseThemeMode(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

/** Caches the choice; a refusing storage is ignored (the choice then lasts for the session). */
export function storeTheme(mode: ThemeMode, storage: Storage | undefined = storageOf()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // quota, blocked site data: the theme still applies, it is just not remembered here
  }
}

/** `html[data-theme]` is `light` or `dark` for a fixed choice and absent for `SYSTEM`. */
export function applyThemeAttribute(root: HTMLElement, mode: ThemeMode): void {
  if (mode === 'LIGHT') {
    root.dataset['theme'] = 'light';
  } else if (mode === 'DARK') {
    root.dataset['theme'] = 'dark';
  } else {
    delete root.dataset['theme'];
  }
}

/**
 * Applies the cached choice before the app bootstraps (main.ts), so a dark board does not flash
 * light first. No inline script in index.html: the CSP allows `script-src 'self'` only.
 */
export function applyStoredTheme(doc: Document = document): void {
  const stored = readStoredTheme();
  if (stored) {
    applyThemeAttribute(doc.documentElement, stored);
  }
}
