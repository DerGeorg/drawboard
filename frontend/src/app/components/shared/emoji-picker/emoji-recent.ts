import { isValidEmoji } from '../../../../board-engine/util/emoji';

const KEY = 'drawboard.emoji.recent';
export const RECENT_LIMIT = 24;

/**
 * The emojis picked last, newest first, from this browser's localStorage. Best effort: every
 * access can throw (private window, blocked site data, quota), and the picker works without it.
 * What is read back is checked again - storage is not a trusted source.
 */
export function loadRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isValidEmoji).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Puts `emoji` first in the list, stores it if the browser lets us, and returns the new list. */
export function rememberRecent(emoji: string, current: readonly string[]): string[] {
  const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // not stored: the list still works for this visit
  }
  return next;
}
