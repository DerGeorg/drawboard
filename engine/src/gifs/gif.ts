/**
 * GIFs from GIPHY (architecture 3.14, Fable decisions G1-G16). The one place that knows what a
 * GIPHY id looks like and what a GIPHY URL is: every `<img src>` of a GIF comes out of `gifUrl`,
 * built from the constants below and a validated id - nothing else from a block's props ever
 * reaches a URL (G9).
 */

/** The only host GIFs are loaded from (G12: the CSP `img-src` names exactly this). */
export const GIPHY_MEDIA_BASE = 'https://media.giphy.com/media/';

/** The id of a GIF at GIPHY (G9). */
const GIPHY_ID = /^[A-Za-z0-9]{1,64}$/;

/** The longest alt text of a GIF block, in UTF-16 units (G9). */
export const MAX_GIF_ALT_LENGTH = 200;

/** Control and format characters (bidi, zero width) and the line and paragraph separators. */
const FORBIDDEN_IN_ALT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const FORBIDDEN_IN_ALT_ALL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * What stands in the file of a block whose id is not valid (a peer wrote garbage into the
 * document): it passes the import rule and is never turned into a URL (see `gifUrl`).
 */
export const GIF_INVALID_ID = 'invalid';

/** The two files of a GIF this app uses: a small one for small blocks, the original otherwise. */
export type GifSize = 'small' | 'original';

const FILE: Readonly<Record<GifSize, string>> = { small: '200w.webp', original: 'giphy.webp' };

/** A block wider than this (board units) shows the original, anything else the 200 px file. */
export const GIF_SMALL_MAX_WIDTH = 320;

export function isValidGiphyId(value: unknown): value is string {
  return typeof value === 'string' && GIPHY_ID.test(value);
}

/** Plain text of at most 200 units without control or format characters (bidi included). */
export function isValidGifAlt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_GIF_ALT_LENGTH &&
    (value as string & { isWellFormed(): boolean }).isWellFormed() &&
    !FORBIDDEN_IN_ALT.test(value)
  );
}

/** An alt text from GIPHY's title: control and format characters out, trimmed, cut to the limit. */
export function cleanGifAlt(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.replace(FORBIDDEN_IN_ALT_ALL, ' ').replace(/\s+/g, ' ').trim();
  let cut = text.slice(0, MAX_GIF_ALT_LENGTH);
  // never end on half of a surrogate pair
  if (!(cut as string & { isWellFormed(): boolean }).isWellFormed()) {
    cut = cut.slice(0, -1);
  }
  return cut.trim();
}

/**
 * The image URL of a GIF: the constant base, the id and one of two constant file names. Undefined
 * for anything that is not a valid id - a hostile prop becomes no request at all.
 */
export function gifUrl(giphyId: unknown, size: GifSize): string | undefined {
  if (!isValidGiphyId(giphyId) || giphyId === GIF_INVALID_ID) {
    return undefined;
  }
  return `${GIPHY_MEDIA_BASE}${giphyId}/${FILE[size]}`;
}

/** The size of a new GIF block: the aspect ratio of the GIF, the longer edge at most `maxEdge`. */
export function gifBlockSize(
  gif: { width: number; height: number },
  maxEdge = 240,
): { w: number; h: number } {
  const width = Number.isFinite(gif.width) && gif.width > 0 ? gif.width : 1;
  const height = Number.isFinite(gif.height) && gif.height > 0 ? gif.height : 1;
  const scale = maxEdge / Math.max(width, height);
  return {
    w: Math.max(48, Math.round(width * scale)),
    h: Math.max(48, Math.round(height * scale)),
  };
}
