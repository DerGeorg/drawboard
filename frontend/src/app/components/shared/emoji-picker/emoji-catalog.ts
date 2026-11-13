import { Service } from '@angular/core';

import { isValidEmoji } from '../../../../board-engine/util/emoji';

export type EmojiGroupKey =
  | 'smileys'
  | 'people'
  | 'animals'
  | 'food'
  | 'travel'
  | 'activities'
  | 'objects'
  | 'symbols'
  | 'flags';

export interface Emoji {
  /** The emoji itself (what goes into a text or a stamp). */
  readonly char: string;
  readonly name: string;
  readonly group: EmojiGroupKey;
  /** Lower-case name and tags, searched as one string. */
  readonly haystack: string;
}

/** An entry of `emojibase-data/en/compact.json`, the fields used here. */
export interface RawEmoji {
  readonly unicode: string;
  readonly label: string;
  readonly tags?: readonly string[];
  readonly group?: number;
}

/**
 * The groups of the data set by its group number. Missing: the skin tone and hair components
 * (2) and the regional indicator letters (no group), which are not emojis to pick on their own.
 */
const GROUP_OF: Readonly<Record<number, EmojiGroupKey>> = {
  0: 'smileys',
  1: 'people',
  3: 'animals',
  4: 'food',
  5: 'travel',
  6: 'activities',
  7: 'objects',
  8: 'symbols',
  9: 'flags',
};

/** Raw data to the emojis the picker offers (skin tone variants are not listed). */
export function toEmojis(raw: readonly RawEmoji[]): Emoji[] {
  const result: Emoji[] = [];
  for (const entry of raw) {
    const group = entry.group === undefined ? undefined : GROUP_OF[entry.group];
    if (!group || !isValidEmoji(entry.unicode)) {
      continue;
    }
    result.push({
      char: entry.unicode,
      name: entry.label,
      group,
      haystack: [entry.label, ...(entry.tags ?? [])].join(' ').toLowerCase(),
    });
  }
  return result;
}

/** Emojis whose name or tags contain every word of `query`; names that match come first. */
export function searchEmojis(emojis: readonly Emoji[], query: string, limit = 240): Emoji[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const byName: Emoji[] = [];
  const byTag: Emoji[] = [];
  for (const emoji of emojis) {
    if (!words.every((w) => emoji.haystack.includes(w))) {
      continue;
    }
    const name = emoji.name.toLowerCase();
    (words.every((w) => name.includes(w)) ? byName : byTag).push(emoji);
  }
  return [...byName, ...byTag].slice(0, limit);
}

/**
 * The emoji data. It is a lazy chunk of the build (`emojibase-data`, MIT): nothing is fetched
 * until the picker opens the first time, and then from the app's own origin (no CDN).
 */
@Service()
export class EmojiCatalog {
  /** Where the raw data comes from; tests replace it. */
  loadRaw: () => Promise<readonly RawEmoji[]> = async () =>
    (await import('emojibase-data/en/compact.json')).default;

  private loading: Promise<readonly Emoji[]> | undefined;

  /** All emojis in the order of the data set; a failed load is tried again on the next call. */
  load(): Promise<readonly Emoji[]> {
    this.loading ??= this.loadRaw().then(toEmojis);
    this.loading.catch(() => (this.loading = undefined));
    return this.loading;
  }
}
