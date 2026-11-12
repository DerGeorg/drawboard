import { Service, inject, signal } from '@angular/core';
import { Board } from '@apps/drawboard-api';

import { Toasts } from '../../../services/toasts';
import { WithSpan } from '../../../util/tracing';
import { BoardActions } from './board-actions';

/**
 * Drag and drop of a board card onto a folder of the sidebar: remembers the dragged board and
 * performs the move. `moves` counts finished moves so the library page reloads its listing.
 */
@Service()
export class BoardMover {
  private readonly actions = inject(BoardActions);
  private readonly toasts = inject(Toasts);

  /** The board being dragged right now; only its owner can move it (the card sets this). */
  readonly dragged = signal<Board | undefined>(undefined);
  readonly moves = signal(0);

  /** Moves `board` into a folder (null = root); true when it worked. */
  @WithSpan('BoardMover.move', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  async move(board: Board, folderId: string | null, folderName?: string): Promise<boolean> {
    if (board.folderId === folderId) {
      return false;
    }
    const moved = await this.actions.move(board, folderId);
    if (moved) {
      this.toasts.success(`"${board.title}" was moved${folderName ? ` to ${folderName}` : ''}.`);
      this.moves.update((n) => n + 1);
    }
    return moved !== undefined;
  }

  /** Drop handler: moves the dragged board, if any. */
  @WithSpan('BoardMover.drop')
  async drop(folderId: string | null, folderName?: string): Promise<void> {
    const board = this.dragged();
    this.dragged.set(undefined);
    if (board) {
      await this.move(board, folderId, folderName);
    }
  }
}
