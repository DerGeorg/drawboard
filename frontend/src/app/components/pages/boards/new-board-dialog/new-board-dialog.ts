import { Component, inject, input, output, signal } from '@angular/core';
import { FormField, FormRoot, form, maxLength, pattern, required } from '@angular/forms/signals';
import { Router } from '@angular/router';
import { Board } from '@apps/drawboard-api';

import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { Modal } from '../../../shared/modal/modal';
import { BoardActions } from '../board-actions';
import { BoardTemplates, FileSummary } from '../board-templates';
import { TemplateFilesDialog } from '../template-files-dialog/template-files-dialog';
import {
  EMPTY_CHOICE,
  TemplateChoice,
  TemplatePicker,
  choiceTitle,
} from '../template-picker/template-picker';

/** The title a new board starts with; it can be changed in the dialog and in the title pill. */
export const DEFAULT_TITLE = 'Untitled board';

interface CreateDraft {
  title: string;
}

/**
 * The dialog behind "New board": start from an empty board, a built-in template or one of the
 * user's templates (copied in the browser, architecture 3.12). The title starts as the
 * template's title and stays editable; creating opens the board in the editor. A failed request
 * is already toasted (with request id) by the error interceptor, the dialog simply stays open.
 * The library page renders it next to the shell, not inside the sidebar: a dialog inside the
 * (transformed) sidebar drawer would be positioned relative to the drawer.
 */
@Component({
  selector: 'drawboard-new-board-dialog',
  imports: [FieldErrors, FormField, FormRoot, Modal, TemplateFilesDialog, TemplatePicker],
  templateUrl: './new-board-dialog.html',
})
export class NewBoardDialog {
  static readonly maxTitleLength = 200;

  private readonly actions = inject(BoardActions);
  private readonly templates = inject(BoardTemplates);
  private readonly router = inject(Router);

  /** Own folder to create the board in; undefined = the top level. */
  readonly folderId = input<string>();

  readonly closed = output();

  protected readonly busy = signal(false);
  /** A template with files waits for the answer to "copy files too?". */
  protected readonly asking = signal<FileSummary | undefined>(undefined);
  protected readonly choice = signal<TemplateChoice>(EMPTY_CHOICE);

  private readonly draft = signal<CreateDraft>({ title: DEFAULT_TITLE });
  /** Once the user typed a title, picking another template no longer overwrites it. */
  private titleEdited = false;

  protected readonly createForm = form(
    this.draft,
    (path) => {
      required(path.title, { message: 'Required.' });
      pattern(path.title, /\S/, { message: 'Required.' });
      maxLength(path.title, NewBoardDialog.maxTitleLength, {
        message: `At most ${NewBoardDialog.maxTitleLength} characters.`,
      });
    },
    { submission: { action: () => this.create().then(() => undefined) } },
  );

  @WithSpan('NewBoardDialog.close')
  protected close(): void {
    if (!this.busy()) {
      this.closed.emit();
    }
  }

  /** The user picked another start: the title follows unless they wrote their own. */
  @WithSpan('NewBoardDialog.choose')
  protected choose(choice: TemplateChoice): void {
    this.choice.set(choice);
    if (!this.titleEdited) {
      this.draft.set({ title: choiceTitle(choice) ?? DEFAULT_TITLE });
    }
  }

  protected markEdited(): void {
    this.titleEdited = true;
  }

  @WithSpan('NewBoardDialog.create')
  protected async create(): Promise<void> {
    const choice = this.choice();
    if (this.busy() || this.asking()) {
      return;
    }
    if (choice.kind === 'board') {
      this.busy.set(true);
      let summary: FileSummary;
      try {
        summary = await this.templates.fileSummary(choice.board);
      } finally {
        this.busy.set(false);
      }
      if (summary.count > 0) {
        this.asking.set(summary);
        return;
      }
    }
    await this.run(true);
  }

  /** The answer to "copy files too?". */
  @WithSpan('NewBoardDialog.answer')
  protected async answer(withFiles: boolean): Promise<void> {
    this.asking.set(undefined);
    await this.run(withFiles);
  }

  @WithSpan('NewBoardDialog.cancelAsking')
  protected cancelAsking(): void {
    this.asking.set(undefined);
  }

  private async run(files: boolean): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      // started before the first await: BoardActions' span becomes a child of this one
      const board = await this.make(this.draft().title.trim(), this.choice(), files);
      if (board) {
        this.closed.emit();
        await this.router.navigate(['/boards', board.id]);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
    } finally {
      this.busy.set(false);
    }
  }

  private make(title: string, choice: TemplateChoice, files: boolean): Promise<Board | undefined> {
    const folderId = this.folderId();
    switch (choice.kind) {
      case 'builtin':
        return this.templates.fromBuiltin(choice.template, { title, folderId });
      case 'board':
        return this.templates.fromBoard(choice.board, { title, folderId, files });
      default:
        return this.actions.create(title, undefined, folderId);
    }
  }
}
