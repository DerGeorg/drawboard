/**
 * What a file block needs from outside the engine (architecture 3.6, S4.4): the metadata of a
 * file and short-lived signed URLs for its bytes. The engine never builds or stores a file URL:
 * the Y.Doc holds only the `fileId`; the host (Angular `BoardFiles`) fetches URLs through the
 * ACL-checked API, renews them before they expire and hands them to the views. URLs are secrets:
 * nothing in the engine logs them.
 */

/** What a file is (contract `BoardFileKind`). */
export type FileKind = 'IMAGE' | 'VIDEO' | 'PDF' | 'DOCUMENT';

/** State of the PDF conversion of an Office document (contract `BoardFileConversion`). */
export type FileConversion = 'NONE' | 'PENDING' | 'DONE' | 'FAILED';

export interface FileMeta {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly kind: FileKind;
  readonly size: number;
  readonly conversion: FileConversion;
  readonly pageCount?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Signed URLs of one file, already resolved against the files origin. */
export interface FileLinks {
  /** The variant a block displays (original, or the converted PDF of a document). */
  readonly url: string;
  readonly thumbnailUrl?: string;
  readonly pdfUrl?: string;
  /** The original, for downloading. */
  readonly originalUrl: string;
  /** Epoch milliseconds after which the URLs stop working. */
  readonly expiresAt: number;
}

export type FileState =
  | { readonly status: 'loading' }
  /** Deleted, never existed on this board, or not reachable from here (e.g. a data-URL board). */
  | { readonly status: 'missing' }
  /** Metadata or URLs could not be loaded (network, server); the source retries by itself. */
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly file: FileMeta; readonly links: FileLinks };

export interface FileSource {
  /**
   * Follows one file: `listener` gets the current state at once (if known) and every change
   * (URLs renewed, conversion finished, file deleted). Returns the unsubscribe function.
   */
  watch(fileId: string, listener: (state: FileState) => void): () => void;
  /** Starts a download of the original with its file name (fresh URL if needed). */
  download(fileId: string): void;
  /**
   * The view's URL failed (expired while it was loaded, network): fetch new URLs now. The
   * listeners of `watch` get them.
   */
  refresh(fileId: string): void;
}

/** A source for boards without file access (data-URL boards, tests): every file is missing. */
export const NO_FILES: FileSource = {
  watch(_fileId, listener) {
    listener({ status: 'missing' });
    return () => undefined;
  },
  download: () => undefined,
  refresh: () => undefined,
};
