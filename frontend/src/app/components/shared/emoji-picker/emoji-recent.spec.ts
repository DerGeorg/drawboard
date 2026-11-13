import { RECENT_LIMIT, loadRecent, rememberRecent } from './emoji-recent';

describe('recent emojis', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  describe('loadRecent and rememberRecent', () => {
    it('when nothing is stored then the list is empty', () => {
      expect(loadRecent(), 'recent').toEqual([]);
    });

    it('when an emoji is remembered then it is first, stored, and not repeated', () => {
      let list = rememberRecent('😀', []);
      list = rememberRecent('🎉', list);
      list = rememberRecent('😀', list);

      expect(list, 'list').toEqual(['😀', '🎉']);
      expect(loadRecent(), 'stored').toEqual(['😀', '🎉']);
    });

    it('when more than the limit are remembered then the oldest fall off', () => {
      let list: string[] = [];
      for (let i = 0; i < RECENT_LIMIT + 5; i++) {
        list = rememberRecent(String.fromCodePoint(0x1f600 + i), list);
      }

      expect(list, 'list').toHaveLength(RECENT_LIMIT);
      expect(loadRecent(), 'stored').toEqual(list);
    });

    it('when the stored value is broken or holds non-emojis then they are dropped', () => {
      localStorage.setItem('drawboard.emoji.recent', '{not json');
      expect(loadRecent(), 'broken').toEqual([]);

      localStorage.setItem('drawboard.emoji.recent', JSON.stringify({ a: 1 }));
      expect(loadRecent(), 'not a list').toEqual([]);

      localStorage.setItem(
        'drawboard.emoji.recent',
        JSON.stringify(['😀', '<img src=x>', 5, null, '🎉']),
      );
      expect(loadRecent(), 'mixed').toEqual(['😀', '🎉']);
    });

    it('when localStorage throws then reading gives an empty list and writing still returns the list', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });

      expect(loadRecent(), 'read').toEqual([]);
      expect(rememberRecent('🎉', ['😀']), 'write').toEqual(['🎉', '😀']);
    });
  });
});
