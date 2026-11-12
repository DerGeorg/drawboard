import { Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { BoardActions } from '../board-actions';

/** The title a new board starts with; it is renamed in the editor's title pill. */
export const DEFAULT_TITLE = 'Untitled board';

/**
 * "+ New board": one click creates a board with a default title and opens it in the editor.
 * Shown as a card in the grid or as a button in the sidebar. A failed request is already
 * toasted (with request id) by the error interceptor, the user simply stays on the library.
 */
@Component({
  selector: 'drawboard-board-create',
  imports: [Icon],
  templateUrl: './board-create.html',
  // block: the card fills its grid cell, the button its column
  host: { class: 'block' },
})
export class BoardCreate {
  private readonly actions = inject(BoardActions);
  private readonly router = inject(Router);

  readonly variant = input<'card' | 'button'>('card');
  /** Own folder to create the board in; undefined = the top level. */
  readonly folderId = input<string>();

  protected readonly busy = signal(false);
  protected readonly card = computed(() => this.variant() === 'card');

  @WithSpan('BoardCreate.create')
  protected async create(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      // started before the first await: BoardActions' span becomes a child of this one
      const board = await this.actions.create(DEFAULT_TITLE, undefined, this.folderId());
      await this.router.navigate(['/boards', board.id]);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
    } finally {
      this.busy.set(false);
    }
  }
}
