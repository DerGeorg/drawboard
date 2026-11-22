import compact from 'emojibase-data/en/compact.json' with { type: 'json' };

import { MAX_EMOJI_LENGTH, isValidEmoji } from './emoji.js';

describe('isValidEmoji', () => {
  describe('values that are emojis', () => {
    it.each([
      ['a simple emoji', '😀'],
      ['an emoji with a variation selector', '❤️'],
      ['an emoji with a skin tone', '👍🏽'],
      ['a ZWJ family (11 units)', '👨‍👩‍👧‍👦'],
      ['a flag of two regional indicators', '🇦🇹'],
      ['a flag with tag characters (England)', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
      ['a keycap digit', '1️⃣'],
      ['a lone regional indicator', '\u{1F1E6}'],
      ['the black flag alone', '\u{1F3F4}'],
      ['a keycap number sign', '#️⃣'],
      ['two emojis', '😀😀'],
    ])('when the value is %s then it is valid', (_name, value) => {
      expect(isValidEmoji(value), value).toBe(true);
    });
  });

  describe('values that are not', () => {
    it.each([
      ['empty', ''],
      ['a letter', 'a'],
      ['a word', 'hello'],
      ['a digit alone', '1'],
      ['leading space', ' 😀'],
      ['trailing space', '😀 '],
      ['a space between', '😀 😀'],
      ['a newline', '😀\n'],
      ['a tab', '\t😀'],
      ['a control character', '😀\u0007'],
      ['a zero width space', '😀​'],
      ['text around an emoji', 'a😀'],
      ['HTML', '<img src=x onerror=alert(1)>'],
      ['HTML around an emoji', '<b>😀</b>'],
      ['a dangling joiner', '‍😀'],
      ['a lone variation selector', '️'],
      ['the black flag with tags but no cancel tag', '\u{1F3F4}\u{E0067}\u{E0062}'],
      ['a tag sequence after another base character', '😀\u{E0061}\u{E0062}\u{E007F}'],
      ['a tag sequence on another flag base', '\u{1F3F3}\u{E0061}\u{E0062}\u{E007F}'],
      ['a cancel tag alone', '\u{1F3F4}\u{E007F}'],
      ['a right-to-left override', '\u202e😀'],
      ['a tab character', '😀\u0009'],
      ['a bare variation selector', '\uFE0F'],
      ['a lone surrogate', '😀\ud83d'],
      ['a number', 5],
      ['null', null],
      ['an object', { emoji: '😀' }],
    ])('when the value is %s then it is invalid', (_name, value) => {
      expect(isValidEmoji(value), String(value)).toBe(false);
    });
  });

  describe('length and data set', () => {
    it('when the value is 32 UTF-16 units then it is valid, and 34 are too long', () => {
      const sixteen = '😀'.repeat(MAX_EMOJI_LENGTH / 2);
      expect(sixteen.length, 'units').toBe(32);

      expect(isValidEmoji(sixteen), '32 units').toBe(true);
      expect(isValidEmoji(sixteen + '😀'), '34 units').toBe(false);
    });

    it('when every emoji of the data set is checked then they are all valid', () => {
      const invalid: string[] = [];
      for (const entry of compact) {
        if (entry.group === undefined || entry.group === 2) {
          continue;
        }
        for (const e of [entry, ...(entry.skins ?? [])]) {
          if (!isValidEmoji(e.unicode)) {
            invalid.push(`${e.hexcode} ${e.label}`);
          }
        }
      }

      expect(invalid, 'invalid emojis of the data set').toEqual([]);
    });
  });
});
