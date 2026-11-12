import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ImportError, writeBoardFile } from '../../../../../board-engine/io/board-file';
import type { BoardFile } from '../../../../../board-engine/io/board-file';
import { decodeDataUrlFragment } from '../../../../../board-engine/io/data-url';
import { BoardDoc } from '../../../../../board-engine/model/board-doc';
import { WithSpan } from '../../../../util/tracing';
import { BoardCanvas } from '../../boards/board-canvas/board-canvas';
import { BoardImporter } from '../../boards/board-importer';
import { Toasts } from '../../../../services/toasts';

/**
 * /open#v1.<data> - shows a board that came inside a link (architecture 3.9, S5.6).
 *
 * The data sits in the URL fragment, so it never reached a server. It is validated like an
 * imported file (limits and schema, S5.5) and shown READ-ONLY: no collaboration socket is
 * opened (a BoardCollab is never created), nothing is saved, there are no embeds (the format
 * carries references only). "Save a copy" creates a real board from the content - the only
 * way it gets stored.
 */
@Component({
  selector: 'drawboard-open-from-link',
  imports: [BoardCanvas, RouterLink],
  templateUrl: './open-from-link.html',
  // the viewer fills the window like the editor
  host: { class: 'relative block h-dvh overflow-hidden' },
})
export class OpenFromLink {
  private readonly importer = inject(BoardImporter);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);

  protected readonly board = signal<BoardDoc | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly saving = signal(false);
  protected readonly title = signal('');
  private file: BoardFile | undefined;

  constructor() {
    try {
      this.file = decodeDataUrlFragment(window.location.hash.slice(1));
      const doc = new BoardDoc();
      writeBoardFile(doc, this.file);
      this.title.set(this.file.title || 'Board from a link');
      this.board.set(doc);
    } catch (error) {
      this.error.set(
        error instanceof ImportError ? error.message : 'This link could not be opened.',
      );
    }
  }

  @WithSpan('OpenFromLink.saveCopy')
  protected async saveCopy(): Promise<void> {
    if (!this.file || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      const board = await this.importer.save(this.file);
      if (board) {
        this.toasts.success(`A copy was saved as "${board.title}".`);
        await this.router.navigate(['/boards', board.id]);
      }
    } finally {
      this.saving.set(false);
    }
  }
}
