import { Unzip, UnzipInflate, UnzipPassThrough, zipSync, strToU8 } from 'fflate';
import * as Y from 'yjs';

import { BoardDoc } from '../model/board-doc';
import { BoardFile, ImportError, boardToFile, parseBoardFile } from './board-file';

/** The limits of architecture S5.5 for a `.drawboard` file. */
export const ARCHIVE_LIMITS = {
  maxZipBytes: 200 * 1024 * 1024,
  maxUnpackedBytes: 500 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxEntries: 1000,
  maxBoardJsonBytes: 20 * 1024 * 1024,
  /** How much of the archive goes into the unzipper at a time (see readArchive). */
  pushBytes: 4096,
} as const;

export const BOARD_JSON = 'board.json';
export const SNAPSHOT_YJS = 'snapshot.yjs';

/**
 * Builds a `.drawboard` archive: `board.json` (readable, with the schema version) and
 * `snapshot.yjs` (the Yjs state, for tools - Drawboard itself never loads it again).
 */
export function exportArchive(board: BoardDoc, title: string): Uint8Array {
  const json = JSON.stringify(boardToFile(board, title), null, 2);
  return zipSync({
    [BOARD_JSON]: strToU8(json),
    [SNAPSHOT_YJS]: Y.encodeStateAsUpdate(board.doc),
  });
}

function badName(name: string): boolean {
  return (
    name.includes('\0') ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[\\/]/).includes('..')
  );
}

/**
 * Reads the board out of a `.drawboard` archive. Limits (S5.5): archive ≤ 200 MB, ≤ 1000
 * entries, ≤ 100 MB per entry and ≤ 500 MB unpacked (as declared - and board.json is counted
 * while it is inflated, so a lying header cannot blow up memory), no `..` or absolute paths,
 * board.json ≤ 20 MB. `snapshot.yjs` and every other entry are NEVER decompressed or loaded.
 */
export function readArchive(bytes: Uint8Array): BoardFile {
  const L = ARCHIVE_LIMITS;
  if (bytes.length > L.maxZipBytes) {
    throw new ImportError('This file is larger than 200 MB and cannot be imported.');
  }
  let entries = 0;
  let declaredTotal = 0;
  let boardJson: Uint8Array | undefined;
  let error: ImportError | undefined;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file) => {
    if (error) {
      return;
    }
    entries++;
    // originalSize is undefined for entries written with the data-descriptor flag, so the
    // declared-size checks below are advisory only; the count while inflating is the real control
    declaredTotal += file.originalSize ?? 0;
    if (entries > L.maxEntries) {
      error = new ImportError('This file has more than 1000 entries and cannot be imported.');
    } else if (badName(file.name)) {
      error = new ImportError('This file has an entry with an unsafe path and cannot be imported.');
    } else if ((file.originalSize ?? 0) > L.maxEntryBytes || declaredTotal > L.maxUnpackedBytes) {
      error = new ImportError('This file unpacks to more than the allowed size.');
    } else if (file.name === BOARD_JSON) {
      const chunks: Uint8Array[] = [];
      let total = 0;
      file.ondata = (err, chunk, final) => {
        if (err) {
          // also the way back of our own throw below: UnzipInflate hands every exception of
          // ondata to ondata again, so keep the first error and throw out of unzip.push
          error ??= new ImportError('board.json in this file is damaged.');
          throw error;
        }
        total += chunk.length;
        if (total > L.maxBoardJsonBytes) {
          // terminate() does nothing for the synchronous UnzipInflate: throwing is what stops the
          // inflating - it ends up outside unzip.push and the catch below turns it into this error
          error = new ImportError('board.json in this file is larger than 20 MB.');
          throw error;
        }
        chunks.push(chunk);
        if (final) {
          boardJson = concat(chunks, total);
        }
      };
      file.start();
    }
    // every other entry (snapshot.yjs included) is skipped without being decompressed
  };
  try {
    // In small pieces: a synchronous inflate expands everything it was given in one go, and
    // deflate reaches about 1000:1 - one push of the whole archive would inflate the whole
    // board.json before ondata could count it. 4 KiB in means at most ~4 MB out per step.
    if (bytes.length === 0) {
      unzip.push(bytes, true);
    }
    for (let at = 0; at < bytes.length; at += L.pushBytes) {
      const end = Math.min(at + L.pushBytes, bytes.length);
      unzip.push(bytes.subarray(at, end), end === bytes.length);
    }
  } catch {
    throw error ?? new ImportError('This file is not a valid .drawboard archive.');
  }
  if (error) {
    throw error;
  }
  if (!boardJson) {
    throw new ImportError('This archive has no board.json.');
  }
  return parseBoardJson(boardJson);
}

/** Parses the bytes of a board.json (UTF-8) and validates them. */
export function parseBoardJson(bytes: Uint8Array): BoardFile {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError('The file is not valid JSON.');
  }
  return parseBoardFile(json);
}

/** True when the bytes start like a ZIP archive (local file header or empty archive). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
