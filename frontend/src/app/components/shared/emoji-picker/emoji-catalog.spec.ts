import { TestBed } from '@angular/core/testing';

import { EmojiCatalog, RawEmoji, searchEmojis, toEmojis } from './emoji-catalog';

const RAW: RawEmoji[] = [
  { unicode: '🇦', label: 'regional indicator A' }, // no group: a letter, not an emoji to pick
  { unicode: '😀', label: 'grinning face', group: 0, tags: ['happy', 'smile'] },
  { unicode: '🙂', label: 'slightly smiling face', group: 0, tags: ['happy'] },
  { unicode: '🏻', label: 'light skin tone', group: 2 }, // a component
  { unicode: 'abc', label: 'not an emoji', group: 0 },
  { unicode: '🐻', label: 'bear', group: 3, tags: ['animal', 'smile'] },
  { unicode: '🇦🇹', label: 'flag: Austria', group: 9, tags: ['at'] },
];

describe('emoji catalog', () => {
  describe('toEmojis', () => {
    it('when raw data is converted then only pickable emojis stay, with their groups', () => {
      const emojis = toEmojis(RAW);

      expect(
        emojis.map((e) => [e.char, e.group]),
        'emojis',
      ).toEqual([
        ['😀', 'smileys'],
        ['🙂', 'smileys'],
        ['🐻', 'animals'],
        ['🇦🇹', 'flags'],
      ]);
    });
  });

  describe('searchEmojis', () => {
    const emojis = toEmojis(RAW);
    const chars = (query: string, limit?: number): string[] =>
      searchEmojis(emojis, query, limit).map((e) => e.char);

    it('when the query is empty then there are no results', () => {
      expect(chars(''), 'empty').toEqual([]);
      expect(chars('   '), 'blank').toEqual([]);
    });

    it('when a word is in the name or a tag then it matches, ignoring case', () => {
      expect(chars('BEAR'), 'name').toEqual(['🐻']);
      expect(chars('austria'), 'name part').toEqual(['🇦🇹']);
      expect(chars('animal'), 'tag').toEqual(['🐻']);
    });

    it('when there are several words then every word must match', () => {
      expect(chars('happy smile'), 'both').toEqual(['😀']);
      expect(chars('happy nothing'), 'one missing').toEqual([]);
    });

    it('when a word is in names and in tags then the names come first', () => {
      // "smil" is in the name of the slightly smiling face and only in the tags of the others
      expect(chars('smil'), 'order').toEqual(['🙂', '😀', '🐻']);
      expect(chars('smile'), 'tags only').toEqual(['😀', '🐻']);
    });

    it('when there are more hits than the limit then the list is cut', () => {
      expect(chars('smil', 2), 'cut').toHaveLength(2);
    });
  });

  describe('EmojiCatalog', () => {
    let catalog: EmojiCatalog;
    beforeEach(() => (catalog = TestBed.inject(EmojiCatalog)));

    it('when the real data is loaded then it holds the emojis of every group', async () => {
      const emojis = await catalog.load();

      expect(emojis.length, 'count').toBeGreaterThan(1500);
      expect(new Set(emojis.map((e) => e.group)).size, 'groups').toBe(9);
      expect(emojis.find((e) => e.char === '😀')?.name, 'a known emoji').toBe('grinning face');
    });

    it('when load is called twice then the data is loaded once', async () => {
      const loadRaw = vi.fn(async () => RAW);
      catalog.loadRaw = loadRaw;

      const [a, b] = await Promise.all([catalog.load(), catalog.load()]);

      expect(a, 'same list').toBe(b);
      expect(loadRaw, 'loads').toHaveBeenCalledTimes(1);
    });

    it('when loading fails then the next call tries again', async () => {
      const loadRaw = vi
        .fn<() => Promise<RawEmoji[]>>()
        .mockRejectedValueOnce(new Error('offline'));
      loadRaw.mockResolvedValue(RAW);
      catalog.loadRaw = loadRaw;

      await expect(catalog.load(), 'first call').rejects.toThrow('offline');
      const second = await catalog.load();

      expect(second.length, 'second call').toBe(4);
      expect(loadRaw, 'loads').toHaveBeenCalledTimes(2);
    });
  });
});
