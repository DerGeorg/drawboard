import { deflateSync, strToU8 } from 'fflate';

import { BoardDoc } from '../model/board-doc';
import {
  DATA_URL_LIMITS,
  decodeDataUrlFragment,
  encodeDataUrlFragment,
  fromBase64Url,
  toBase64Url,
} from './data-url';
import { ImportError } from './board-file';

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error, 'error type').toBeInstanceOf(ImportError);
    return (error as ImportError).message;
  }
  return 'NOT REJECTED';
}

describe('data URL', () => {
  describe('base64url', () => {
    it('when bytes are encoded then no padding or +/ appear and they decode back', () => {
      const bytes = Uint8Array.from([251, 255, 254, 0, 1]);

      const text = toBase64Url(bytes);

      expect(text, 'alphabet').toMatch(/^[A-Za-z0-9_-]+$/);
      expect([...fromBase64Url(text)], 'round trip').toEqual([...bytes]);
    });

    it('when the text has other characters then it is refused', () => {
      expect(
        message(() => fromBase64Url('abc$')),
        'message',
      ).toContain('damaged');
    });
  });

  describe('encode and decode', () => {
    it('when a board is encoded then the fragment starts with v1. and decodes to the same board', () => {
      const board = new BoardDoc();
      board.addBlock({ type: 'core.sticky', x: 1, y: 2, w: 100, h: 100, text: 'shared' });

      const fragment = encodeDataUrlFragment(board, 'Shared board');
      const file = decodeDataUrlFragment(fragment);

      expect(fragment.startsWith('v1.'), 'prefix').toBe(true);
      expect(file.title, 'title').toBe('Shared board');
      expect(file.blocks[0]?.text, 'text').toBe('shared');
    });

    it('when the compressed board exceeds 1 MB then encoding refuses with a hint to export', () => {
      const board = new BoardDoc();
      // incompressible content: random text
      const random = Array.from({ length: 1_500_000 }, () =>
        String.fromCharCode(33 + Math.floor(Math.random() * 90)),
      ).join('');
      for (let i = 0; i < 15; i++) {
        board.addBlock({
          type: 'core.text',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          text: random.slice(i * 100_000, (i + 1) * 100_000),
        });
      }

      expect(
        message(() => encodeDataUrlFragment(board, 'Big')),
        'message',
      ).toContain('Export it as a file');
    });
  });

  describe('limits', () => {
    it('when the fragment has another version prefix then it is refused', () => {
      expect(
        message(() => decodeDataUrlFragment('v2.abc')),
        'message',
      ).toContain('not a Drawboard board link');
      expect(
        message(() => decodeDataUrlFragment('abc')),
        'message',
      ).toContain('not a Drawboard board link');
    });

    it('when the compressed data is larger than 1 MB then it is refused', () => {
      const big = new Uint8Array(DATA_URL_LIMITS.maxCompressedBytes + 1);

      expect(
        message(() => decodeDataUrlFragment('v1.' + toBase64Url(big))),
        'message',
      ).toContain('larger than 1 MB');
    });

    it('when the fragment is empty then it is refused', () => {
      expect(
        message(() => decodeDataUrlFragment('v1.')),
        'message',
      ).toContain('empty');
    });

    it('when the data inflates to more than 10 MB then inflating is aborted and it is refused', () => {
      const bomb = deflateSync(new Uint8Array(DATA_URL_LIMITS.maxInflatedBytes + 1_000_000));

      expect(bomb.length, 'the bomb is small').toBeLessThan(DATA_URL_LIMITS.maxCompressedBytes);
      expect(
        message(() => decodeDataUrlFragment('v1.' + toBase64Url(bomb))),
        'message',
      ).toContain('more than 10 MB');
    });

    it('when the data is not deflate then it is refused as damaged', () => {
      const junk = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 251);

      expect(
        message(() => decodeDataUrlFragment('v1.' + toBase64Url(junk))),
        'message',
      ).toMatch(/damaged|not valid JSON/);
    });

    it('when the data inflates to something that is not a board then validation refuses it', () => {
      const text = deflateSync(strToU8('{"schemaVersion":1,"blocks":[{"type":"acme.evil"}]}'));

      expect(
        message(() => decodeDataUrlFragment('v1.' + toBase64Url(text))),
        'message',
      ).toContain('unknown type');
    });
  });
});
