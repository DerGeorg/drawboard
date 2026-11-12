import { Inflate, deflateSync, strToU8 } from 'fflate';

import { BoardDoc } from '../model/board-doc';
import { parseBoardJson } from './archive';
import { BoardFile, ImportError, boardToFile } from './board-file';

/** The limits of architecture S5.6 for a data URL. */
export const DATA_URL_LIMITS = {
  maxCompressedBytes: 1024 * 1024,
  maxInflatedBytes: 10 * 1024 * 1024,
} as const;

export const DATA_URL_PREFIX = 'v1.';

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new ImportError('The link is damaged.');
  }
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    throw new ImportError('The link is damaged.');
  }
}

/**
 * The fragment of a data URL: `v1.<base64url(deflate(board.json))>` (raw DEFLATE, RFC 1951).
 * References only - there are no embedded files. Throws when the result exceeds 1 MB.
 */
export function encodeDataUrlFragment(board: BoardDoc, title: string): string {
  const json = JSON.stringify(boardToFile(board, title));
  const compressed = deflateSync(strToU8(json), { level: 9 });
  if (compressed.length > DATA_URL_LIMITS.maxCompressedBytes) {
    throw new ImportError(
      'This board is too large for a link (more than 1 MB compressed). Export it as a file instead.',
    );
  }
  return DATA_URL_PREFIX + toBase64Url(compressed);
}

/**
 * Reads a data URL fragment (without the `#`): compressed size ≤ 1 MB, inflating is aborted as
 * soon as 10 MB came out (a decompression bomb never gets bigger in memory), then the same
 * validation as for a file (S5.5).
 */
export function decodeDataUrlFragment(fragment: string): BoardFile {
  if (!fragment.startsWith(DATA_URL_PREFIX)) {
    throw new ImportError('This link is not a Drawboard board link (or from a newer version).');
  }
  const compressed = fromBase64Url(fragment.slice(DATA_URL_PREFIX.length));
  if (compressed.length === 0 || compressed.length > DATA_URL_LIMITS.maxCompressedBytes) {
    throw new ImportError('This board link is empty or larger than 1 MB.');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let error: ImportError | undefined;
  const inflate = new Inflate((chunk) => {
    if (error) {
      return;
    }
    total += chunk.length;
    if (total > DATA_URL_LIMITS.maxInflatedBytes) {
      error = new ImportError('This board link unpacks to more than 10 MB.');
      return;
    }
    chunks.push(chunk);
  });
  try {
    // small slices, so the limit is checked often and a bomb is stopped early
    for (let at = 0; at < compressed.length && !error; at += 4096) {
      const end = Math.min(at + 4096, compressed.length);
      inflate.push(compressed.subarray(at, end), end === compressed.length);
    }
  } catch {
    throw error ?? new ImportError('The link is damaged.');
  }
  if (error) {
    throw error;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return parseBoardJson(out);
}
