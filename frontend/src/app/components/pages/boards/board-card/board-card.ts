import { HttpContext } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import {
  FieldTree,
  FormField,
  FormRoot,
  TreeValidationResult,
  form,
  maxLength,
  required,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import { Board, BoardRole } from '@apps/drawboard-api';

import { FIELD_ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { Toasts } from '../../../../services/toasts';
import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { relativeTime } from '../../../../util/relative-time';
import { violationsToFieldErrors } from '../../../../util/violations';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { Icon } from '../../../shared/icon/icon';
import { RoleBadge } from '../../../shared/role-badge/role-badge';
import { BoardActions } from '../board-actions';
import { BoardMover } from '../board-mover';
import { FolderPicker } from '../folder-picker/folder-picker';
import { ShareDialog } from '../share-dialog/share-dialog';

/** What the inline form edits - the changeable fields of a board. */
interface RenameDraft {
  title: string;
}

/**
 * One board of the library as a card: a preview area (a placeholder pattern until M2 brings
 * thumbnails), title, "edited <time>", role badge and a menu with Rename and Delete - depending
 * on the user's role on the board. The role only decides what is offered (UX); the backend
 * enforces it. Emits `changed` whenever the list is out of date (renamed, deleted, or a 409
 * because someone else changed the board first).
 */
@Component({
  selector: 'drawboard-board-card',
  imports: [
    RouterLink,
    FormField,
    FormRoot,
    FieldErrors,
    FolderPicker,
    Icon,
    RoleBadge,
    ShareDialog,
  ],
  templateUrl: './board-card.html',
  host: { '(keydown.escape)': 'closeMenu()' },
})
export class BoardCard {
  static readonly maxTitleLength = 200;

  private readonly actions = inject(BoardActions);
  private readonly toasts = inject(Toasts);
  private readonly mover = inject(BoardMover);

  readonly board = input.required<Board>();
  readonly changed = output();

  protected readonly editing = signal(false);
  protected readonly busy = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly confirmingDelete = signal(false);
  protected readonly moving = signal(false);
  protected readonly sharing = signal(false);

  /** "5 minutes ago"; read when the card renders, which is as fresh as a list needs. */
  protected readonly edited = computed(() => relativeTime(this.board().updatedAt));

  protected readonly canRename = computed(
    () => this.board().role === BoardRole.OWNER || this.board().role === BoardRole.EDITOR,
  );
  protected readonly canDelete = computed(() => this.board().role === BoardRole.OWNER);
  /** Moving a board between folders is the owner's job. */
  protected readonly canMove = this.canDelete;

  /** Editable copy of the title - reset whenever another version of the board arrives. */
  private readonly draft = linkedSignal<RenameDraft>(() => ({ title: this.board().title }));

  protected readonly renameForm = form(
    this.draft,
    (path) => {
      required(path.title, { message: 'Required.' });
      maxLength(path.title, BoardCard.maxTitleLength, {
        message: `At most ${BoardCard.maxTitleLength} characters.`,
      });
    },
    { submission: { action: (field) => this.rename(field) } },
  );

  @WithSpan('BoardCard.toggleMenu')
  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  @WithSpan('BoardCard.closeMenu')
  protected closeMenu(): void {
    this.menuOpen.set(false);
    this.confirmingDelete.set(false);
  }

  @WithSpan('BoardCard.startRename')
  protected startRename(): void {
    this.menuOpen.set(false);
    this.editing.set(true);
  }

  @WithSpan('BoardCard.startShare')
  protected startShare(): void {
    this.menuOpen.set(false);
    this.sharing.set(true);
  }

  @WithSpan('BoardCard.stopShare')
  protected stopShare(): void {
    this.sharing.set(false);
  }

  @WithSpan('BoardCard.startMove')
  protected startMove(): void {
    this.menuOpen.set(false);
    this.moving.set(true);
  }

  @WithSpan('BoardCard.stopMove')
  protected stopMove(): void {
    this.moving.set(false);
  }

  @WithSpan('BoardCard.move', {
    attributes: (folderId: string | null) => ({ 'folder.id': folderId ?? 'root' }),
  })
  protected async move(folderId: string | null): Promise<void> {
    this.moving.set(false);
    await this.mover.move(this.board(), folderId);
  }

  @WithSpan('BoardCard.dragStart')
  protected dragStart(event: DragEvent): void {
    if (!this.canMove()) {
      return;
    }
    this.mover.dragged.set(this.board());
    event.dataTransfer?.setData('text/plain', this.board().title);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  @WithSpan('BoardCard.dragEnd')
  protected dragEnd(): void {
    this.mover.dragged.set(undefined);
  }

  @WithSpan('BoardCard.askDelete')
  protected askDelete(): void {
    this.menuOpen.set(false);
    this.confirmingDelete.set(true);
  }

  /** The submission action of the inline form - the user action "rename the board", a span. */
  @WithSpan('BoardCard.rename')
  private async rename(field: FieldTree<RenameDraft>): Promise<TreeValidationResult> {
    const context = new HttpContext().set(FIELD_ERRORS_HANDLED_LOCALLY, true);
    try {
      // started before the first await: BoardActions' span becomes a child of this one
      await this.actions.rename(this.board(), field().value().title, context);
      this.toasts.success('Board renamed.');
      this.editing.set(false);
      this.changed.emit();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409) {
          // someone else was faster (toast already shown): show the current state
          this.editing.set(false);
          this.changed.emit();
          return undefined;
        }
        // violations -> at the field; anything else was toasted by the error interceptor
        return violationsToFieldErrors(field, error.violations);
      }
      throw error;
    }
  }

  @WithSpan('BoardCard.remove', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  protected async remove(board: Board): Promise<void> {
    this.busy.set(true);
    try {
      if (await this.actions.delete(board)) {
        this.changed.emit();
      }
    } finally {
      this.busy.set(false);
      this.confirmingDelete.set(false);
    }
  }
}
