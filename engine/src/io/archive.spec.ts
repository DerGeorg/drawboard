import { UnzipInflate, strToU8, zipSync } from 'fflate';

import { BoardDoc } from '../model/board-doc.js';
import {
  ARCHIVE_LIMITS,
  BOARD_JSON,
  SNAPSHOT_YJS,
  exportArchive,
  looksLikeZip,
  parseBoardJson,
  readArchive,
} from './archive.js';
import { ImportError } from './board-file.js';

const validJson = JSON.stringify({
  schemaVersion: 1,
  title: 'T',
  blocks: [{ id: 'b1', type: 'core.sticky', x: 0, y: 0, w: 10, h: 10, text: 'x', props: {} }],
});

function zip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files);
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error, 'error type').toBeInstanceOf(ImportError);
    return (error as ImportError).message;
  }
  return 'NOT REJECTED';
}

/** Limits are plain properties: tests lower them to avoid building 500 MB archives. */
function withLimit<K extends keyof typeof ARCHIVE_LIMITS>(
  key: K,
  value: number,
  fn: () => void,
): void {
  const limits = ARCHIVE_LIMITS as { -readonly [P in keyof typeof ARCHIVE_LIMITS]: number };
  const before = limits[key];
  limits[key] = value;
  try {
    fn();
  } finally {
    limits[key] = before;
  }
}

/**
 * Counts what the inflater hands to the `ondata` of an entry: all chunks, and those that came
 * after the running total had already passed `limit` bytes.
 */
function countInflatedChunks(
  run: () => void,
  limit = 1000,
): { chunks: number; afterLimit: number; bytes: number } {
  const counts = { chunks: 0, afterLimit: 0, bytes: 0 };
  let total = 0;
  const key = Symbol('ondata');
  Object.defineProperty(UnzipInflate.prototype, 'ondata', {
    configurable: true,
    get(this: Record<symbol, unknown>) {
      return this[key];
    },
    set(this: Record<symbol, unknown>, handler: (e: unknown, c: Uint8Array, f: boolean) => void) {
      this[key] = (e: unknown, chunk: Uint8Array, final: boolean) => {
        if (chunk) {
          counts.chunks++;
          if (total > limit) {
            counts.afterLimit++;
          }
          total += chunk.length;
          counts.bytes = total;
        }
        handler(e, chunk, final);
      };
    },
  });
  try {
    run();
  } finally {
    delete (UnzipInflate.prototype as unknown as Record<string, unknown>)['ondata'];
  }
  return counts;
}

describe('archive', () => {
  describe('exportArchive and readArchive', () => {
    it('when a board is exported then board.json and snapshot.yjs are inside and the board reads back', () => {
      const board = new BoardDoc();
      board.addBlock({ type: 'core.sticky', x: 5, y: 6, w: 100, h: 100, text: 'hello' });

      const bytes = exportArchive(board, 'Plan');
      const file = readArchive(bytes);

      expect(looksLikeZip(bytes), 'zip signature').toBe(true);
      expect(file.title, 'title').toBe('Plan');
      expect(file.blocks[0]?.text, 'text').toBe('hello');
      expect(file.schemaVersion, 'schema version').toBe(1);
    });

    it('when the archive holds a snapshot.yjs full of garbage then it is never read', () => {
      const bytes = zip({
        [BOARD_JSON]: strToU8(validJson),
        [SNAPSHOT_YJS]: new Uint8Array([1, 2, 3, 255, 254, 253]),
      });

      expect(readArchive(bytes).blocks.length, 'blocks from board.json only').toBe(1);
    });
  });

  describe('limits', () => {
    it('when the archive is larger than the ZIP limit then it is refused before anything is read', () => {
      withLimit('maxZipBytes', 10, () => {
        expect(
          message(() => readArchive(new Uint8Array(11))),
          'message',
        ).toContain('200 MB');
      });
    });

    it('when there are more entries than allowed then it is refused', () => {
      withLimit('maxEntries', 2, () => {
        const bytes = zip({ [BOARD_JSON]: strToU8(validJson), a: strToU8('a'), b: strToU8('b') });

        expect(
          message(() => readArchive(bytes)),
          'message',
        ).toContain('more than 1000 entries');
      });
    });

    it('when an entry unpacks to more than the per-entry limit then it is refused', () => {
      withLimit('maxEntryBytes', 100, () => {
        const bytes = zip({ [BOARD_JSON]: strToU8(validJson), big: new Uint8Array(1000) });

        expect(
          message(() => readArchive(bytes)),
          'message',
        ).toContain('allowed size');
      });
    });

    it('when all entries together unpack to more than the total limit then it is refused', () => {
      withLimit('maxUnpackedBytes', 1500, () => {
        const bytes = zip({
          a: new Uint8Array(1000),
          b: new Uint8Array(1000),
          [BOARD_JSON]: strToU8(validJson),
        });

        expect(
          message(() => readArchive(bytes)),
          'message',
        ).toContain('allowed size');
      });
    });

    it('when board.json inflates to more than the limit then it is refused while inflating', () => {
      // a small limit: building and inflating a real 20 MB archive takes seconds on a busy runner
      withLimit('maxBoardJsonBytes', 1000, () => {
        const bytes = zip({ [BOARD_JSON]: new Uint8Array(1001) });

        expect(
          message(() => readArchive(bytes)),
          'message',
        ).toContain('larger than 20 MB');
      });
    });

    it('when board.json inflates past the limit then the inflating stops at once', () => {
      // 4 MB of zeros, 256-byte pieces: one push of everything would inflate all 4 MB at once
      const bytes = zip({ [BOARD_JSON]: new Uint8Array(4 * 1024 * 1024) });
      const calls = countInflatedChunks(() => {
        withLimit('pushBytes', 256, () => {
          withLimit('maxBoardJsonBytes', 1000, () => {
            expect(
              message(() => readArchive(bytes)),
              'message',
            ).toContain('larger than 20 MB');
          });
        });
      });

      expect(calls.chunks, 'chunks delivered').toBeGreaterThan(0);
      expect(calls.afterLimit, 'chunks delivered after the limit was passed').toBe(0);
      expect(calls.bytes, 'bytes inflated before it stopped').toBeLessThan(1024 * 1024);
    });
  });

  describe('paths', () => {
    it.each([
      ['a parent directory', '../evil.txt'],
      ['a nested parent directory', 'a/../../evil.txt'],
      ['an absolute path', '/etc/passwd'],
      ['a backslash path', '\\windows\\x'],
      ['a drive path', 'C:\\x'],
      ['a backslash parent', '..\\x'],
    ])('when an entry has %s then the archive is refused', (_name, path) => {
      const bytes = zip({ [BOARD_JSON]: strToU8(validJson), [path]: strToU8('x') });

      expect(
        message(() => readArchive(bytes)),
        'message',
      ).toContain('unsafe path');
    });
  });

  describe('damaged input', () => {
    it('when the bytes are not a ZIP then the archive is refused', () => {
      expect(
        message(() => readArchive(strToU8('this is not a zip file at all'))),
        'message',
      ).toContain('no board.json');
    });

    it('when board.json is missing then the archive is refused', () => {
      expect(
        message(() => readArchive(zip({ other: strToU8('x') }))),
        'message',
      ).toContain('no board.json');
    });

    it('when board.json is not JSON then it is refused', () => {
      const bytes = zip({ [BOARD_JSON]: strToU8('{nope') });

      expect(
        message(() => readArchive(bytes)),
        'message',
      ).toContain('not valid JSON');
    });

    it('when board.json is not UTF-8 then it is refused', () => {
      expect(
        message(() => parseBoardJson(new Uint8Array([0xff, 0xfe, 0xfd]))),
        'message',
      ).toContain('not valid JSON');
    });

    it('when the bytes have no ZIP signature then looksLikeZip says so', () => {
      expect(looksLikeZip(strToU8('{"a":1}')), 'JSON').toBe(false);
      expect(looksLikeZip(new Uint8Array(2)), 'too short').toBe(false);
    });
  });
});
