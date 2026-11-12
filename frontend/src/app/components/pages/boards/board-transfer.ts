import { Service, inject } from '@angular/core';
import { Router } from '@angular/router';

import {
  ARCHIVE_LIMITS,
  exportArchive,
  looksLikeZip,
  parseBoardJson,
  readArchive,
} from '../../../../board-engine/io/archive';
import { BoardFile, ImportError } from '../../../../board-engine/io/board-file';
import { encodeDataUrlFragment } from '../../../../board-engine/io/data-url';
import type { BoardDoc } from '../../../../board-engine/model/board-doc';
import { Toasts } from '../../../services/toasts';
import { WithSpan } from '../../../util/tracing';
import { BoardImporter } from './board-importer';

/** Characters a file name may keep; everything else becomes "_". */
function fileName(title: string): string {
  const base = title
    .replace(/[^\w .-]+/g, '_')
    .trim()
    .slice(0, 100);
  return `${base || 'board'}.drawboard`;
}

/**
 * Export (.drawboard), "Copy as link" and Import of the editor's ⋯ menu. Everything runs in
 * the browser. Spans carry no titles or content.
 */
@Service()
export class BoardTransfer {
  private readonly toasts = inject(Toasts);
  private readonly importer = inject(BoardImporter);
  private readonly router = inject(Router);

  /** Downloads the board as a `.drawboard` archive (board.json + snapshot.yjs). */
  @WithSpan('BoardTransfer.exportFile')
  exportFile(board: BoardDoc, title: string): void {
    const bytes = exportArchive(board, title);
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(title);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Copies `<origin>/open#v1.<base64url(deflate(board.json))>` (references only, ≤ 1 MB). */
  @WithSpan('BoardTransfer.copyLink')
  async copyLink(board: BoardDoc, title: string): Promise<void> {
    try {
      const url = `${window.location.origin}/open#${encodeDataUrlFragment(board, title)}`;
      await navigator.clipboard.writeText(url);
      this.toasts.success('Link copied. Whoever opens it (signed in) sees a read-only copy.');
    } catch (error) {
      this.toasts.error(
        error instanceof ImportError ? error.message : 'The link could not be copied.',
      );
    }
  }

  /** Reads a `.drawboard` archive or a board.json and validates it (S5.5). */
  async readFile(file: File): Promise<BoardFile> {
    if (file.size > ARCHIVE_LIMITS.maxZipBytes) {
      throw new ImportError('This file is larger than 200 MB and cannot be imported.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (looksLikeZip(bytes)) {
      return readArchive(bytes);
    }
    if (bytes.length > ARCHIVE_LIMITS.maxBoardJsonBytes) {
      throw new ImportError('board.json is larger than 20 MB and cannot be imported.');
    }
    return parseBoardJson(bytes);
  }

  /** Imports the file as a NEW board and opens it. */
  @WithSpan('BoardTransfer.importFile')
  async importFile(file: File): Promise<void> {
    let content: BoardFile;
    try {
      content = await this.readFile(file);
    } catch (error) {
      this.toasts.error(
        error instanceof ImportError ? error.message : 'The file could not be read.',
      );
      return;
    }
    const board = await this.importer.save(content);
    if (board) {
      this.toasts.success(`"${board.title}" was imported.`);
      await this.router.navigate(['/boards', board.id]);
    }
  }
}
