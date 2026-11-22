import {
  GIF_INVALID_ID,
  GIPHY_MEDIA_BASE,
  MAX_GIF_ALT_LENGTH,
  cleanGifAlt,
  gifBlockSize,
  gifUrl,
  isValidGifAlt,
  isValidGiphyId,
} from './gif.js';

describe('GIF ids, URLs and texts (G9)', () => {
  describe('isValidGiphyId', () => {
    it.each(['3o7TKSjRrfIPjeiVyM', 'a', 'A9', 'x'.repeat(64)])(
      'when the id is %s then it passes',
      (id) => {
        expect(isValidGiphyId(id), id).toBe(true);
      },
    );

    it.each([
      '',
      'x'.repeat(65),
      '../etc',
      'a/b',
      'a.b',
      'a b',
      'a?b=1',
      'a#b',
      'a%2fb',
      'a-b',
      'a_b',
      'é',
      'a\n',
      'https://evil.example/x',
      '<img src=x>',
      '"onerror=1',
      42,
      null,
      undefined,
      {},
    ])('when the id is %j then it is refused', (id) => {
      expect(isValidGiphyId(id), String(id)).toBe(false);
    });
  });

  describe('gifUrl', () => {
    it('when the id is valid then the URL is the constant base, the id and a constant file', () => {
      expect(gifUrl('abc123', 'small'), 'small').toBe(
        'https://media.giphy.com/media/abc123/200w.webp',
      );
      expect(gifUrl('abc123', 'original'), 'original').toBe(
        'https://media.giphy.com/media/abc123/giphy.webp',
      );
      expect(GIPHY_MEDIA_BASE, 'base').toBe('https://media.giphy.com/media/');
    });

    it.each([
      '../x',
      'a/../b',
      'a.evil.example/x',
      'x?y=1',
      'x#y',
      'x@evil.example',
      '',
      'x'.repeat(65),
    ])('when the id is %j then there is no URL at all', (id) => {
      expect(gifUrl(id, 'small'), id).toBeUndefined();
      expect(gifUrl(id, 'original'), id).toBeUndefined();
    });

    it('when the id is the one of an unavailable block then there is no URL', () => {
      expect(gifUrl(GIF_INVALID_ID, 'small'), 'no URL for the unavailable id').toBeUndefined();
    });

    it('when any valid id is turned into a URL then host, protocol and path shape never change', () => {
      for (const id of ['a', 'Z9', 'x'.repeat(64)]) {
        const url = new URL(gifUrl(id, 'small') as string);
        expect(url.protocol, 'protocol').toBe('https:');
        expect(url.host, 'host').toBe('media.giphy.com');
        expect(url.search + url.hash + url.username + url.password, 'nothing else').toBe('');
        expect(url.pathname, 'path').toBe(`/media/${id}/200w.webp`);
      }
    });
  });

  describe('alt text', () => {
    it('when the text is plain and short then it is valid', () => {
      expect(isValidGifAlt('A cat falls off a table'), 'sentence').toBe(true);
      expect(isValidGifAlt(''), 'empty').toBe(true);
      expect(isValidGifAlt('x'.repeat(MAX_GIF_ALT_LENGTH)), 'at the limit').toBe(true);
    });

    it.each([
      ['too long', 'x'.repeat(MAX_GIF_ALT_LENGTH + 1)],
      ['a control character', 'a\u0007b'],
      ['a newline', 'a\nb'],
      ['a right-to-left override', 'a\u202Eb'],
      ['an isolate', 'a\u2066b'],
      ['a zero width joiner', 'a\u200Db'],
      ['a line separator', 'a\u2028b'],
      ['a lone surrogate', 'a\uD800b'],
      ['a number', 42],
    ])('when the text has %s then it is refused', (_what, value) => {
      expect(isValidGifAlt(value), 'refused').toBe(false);
    });

    it('when a title from GIPHY is cleaned then control and bidi characters are gone and the length is cut', () => {
      expect(cleanGifAlt('  Cat \u202E\nfalls\t off  '), 'cleaned').toBe('Cat falls off');
      expect(cleanGifAlt('x'.repeat(500)).length, 'cut').toBe(MAX_GIF_ALT_LENGTH);
      expect(isValidGifAlt(cleanGifAlt('😀'.repeat(150))), 'no half surrogate').toBe(true);
      expect(cleanGifAlt(undefined), 'not a string').toBe('');
    });
  });

  describe('gifBlockSize', () => {
    it('when a GIF is wide then the block keeps its aspect ratio with the long edge at 240', () => {
      expect(gifBlockSize({ width: 480, height: 270 }), 'wide GIF').toEqual({ w: 240, h: 135 });
      expect(gifBlockSize({ width: 100, height: 400 }), 'tall GIF').toEqual({ w: 60, h: 240 });
    });

    it('when the numbers are nonsense then the size is still finite and positive', () => {
      const size = gifBlockSize({ width: Number.NaN, height: -4 });
      expect(
        Number.isFinite(size.w) && size.w > 0 && Number.isFinite(size.h) && size.h > 0,
        'unused',
      ).toBe(true);
    });
  });
});
