import { HttpContext } from '@angular/common/http';
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
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
import { violationsToFieldErrors } from '../../../../util/violations';
import { Icon } from '../../../shared/icon/icon';
import { IconName } from '../../../shared/icon/icons';
import type { BoardDoc } from '@apps/drawboard-engine';
import { AboutDialog } from '../../../shared/about-dialog/about-dialog';
import { RoleBadge } from '../../../shared/role-badge/role-badge';
import { ThemeMenu } from '../../../shared/theme-menu/theme-menu';
import { VersionHistory } from '../version-history/version-history';
import { BoardActions } from '../board-actions';
import { BoardTemplates, FileSummary } from '../board-templates';
import { TemplateFilesDialog } from '../template-files-dialog/template-files-dialog';
import { BoardTransfer } from '../board-transfer';

interface TitleDraft {
  title: string;
}

interface MenuEntry {
  id: 'export' | 'link' | 'import' | 'saveTemplate' | 'template' | 'history' | 'about';
  label: string;
  icon: IconName;
  /** A switch: "On" or "Off" is shown at the right and the item is a menu item checkbox. */
  checked?: boolean;
}

/**
 * The pill at the top left: back to the library, the board title (click to rename in place,
 * optimistic locking through BoardActions.rename) and a "more" menu: export (.drawboard), copy as link,
 * import into a new board, "Save as template" and, for the owner, the template switch and the
 * version history.
 */
@Component({
  selector: 'drawboard-board-title-bar',
  imports: [
    RouterLink,
    FormField,
    FormRoot,
    Icon,
    RoleBadge,
    TemplateFilesDialog,
    VersionHistory,
    AboutDialog,
    ThemeMenu,
  ],
  templateUrl: './board-title-bar.html',
  host: { '(keydown.escape)': 'closeMenu()' },
})
export class BoardTitleBar {
  static readonly maxTitleLength = 200;

  private readonly actions = inject(BoardActions);
  private readonly toasts = inject(Toasts);
  private readonly transfer = inject(BoardTransfer);
  private readonly templates = inject(BoardTemplates);

  /** Undefined while the board loads: only the back link shows. */
  readonly board = input<Board>();
  /** The live document, for export and "Copy as link". */
  readonly doc = input<BoardDoc>();
  /** A guest cannot rename or use the menu. */
  readonly guest = input(false);
  /** Where the back arrow leads; null = nowhere (a guest of a single board). */
  readonly backLink = input<string | null>('/boards');
  /** The title changed (or a newer version exists): the page reloads the board. */
  readonly changed = output();

  protected readonly editing = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly historyOpen = signal(false);
  protected readonly aboutOpen = signal(false);
  protected readonly importing = signal(false);
  protected readonly savingTemplate = signal(false);
  /** The board has files: "copy files too?" is open. */
  protected readonly askingFiles = signal<FileSummary | undefined>(undefined);
  protected readonly menu = computed<readonly MenuEntry[]>(() => {
    const entries: MenuEntry[] = [
      { id: 'export', label: 'Export (.drawboard)', icon: 'export' },
      { id: 'link', label: 'Copy as link', icon: 'share' },
      { id: 'import', label: this.importing() ? 'Importing…' : 'Import…', icon: 'import' },
    ];
    entries.push({
      id: 'saveTemplate',
      label: this.savingTemplate() ? 'Saving…' : 'Save as template',
      icon: 'template',
    });
    // only the owner may switch the template flag, list and restore versions
    if (this.board()?.role === BoardRole.OWNER) {
      entries.push({
        id: 'template',
        label: 'Template',
        icon: 'template',
        checked: this.board()?.template === true,
      });
      entries.push({ id: 'history', label: 'Version history', icon: 'history' });
    }
    entries.push({ id: 'about', label: 'About Drawboard', icon: 'info' });
    return entries;
  });

  protected readonly canRename = computed(() => {
    const role = this.board()?.role;
    return !this.guest() && (role === BoardRole.OWNER || role === BoardRole.EDITOR);
  });

  /** Editable copy of the title - reset whenever another version of the board arrives. */
  private readonly draft = linkedSignal<TitleDraft>(() => ({ title: this.board()?.title ?? '' }));

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly titleForm = form(
    this.draft,
    (path) => {
      required(path.title, { message: 'Required.' });
      maxLength(path.title, BoardTitleBar.maxTitleLength, {
        message: `At most ${BoardTitleBar.maxTitleLength} characters.`,
      });
    },
    { submission: { action: (field) => this.rename(field) } },
  );

  constructor() {
    // the field exists only after the click that asked for it: focus it then (autofocus does
    // not fire for elements added later)
    effect(() => {
      const input = this.titleInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
  }

  @WithSpan('BoardTitleBar.startRename')
  protected startRename(): void {
    if (this.canRename()) {
      this.draft.set({ title: this.board()?.title ?? '' });
      this.editing.set(true);
    }
  }

  @WithSpan('BoardTitleBar.cancelRename')
  protected cancelRename(): void {
    this.editing.set(false);
  }

  /** Leaving the field saves a changed title and silently drops an unchanged or invalid one. */
  @WithSpan('BoardTitleBar.blurRename')
  protected blurRename(formElement: HTMLFormElement): void {
    if (!this.editing()) {
      return;
    }
    const unchanged = this.draft().title.trim() === this.board()?.title;
    if (unchanged || this.titleForm().invalid()) {
      this.editing.set(false);
    } else {
      formElement.requestSubmit();
    }
  }

  @WithSpan('BoardTitleBar.toggleMenu')
  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  @WithSpan('BoardTitleBar.choose')
  protected async choose(entry: MenuEntry): Promise<void> {
    this.menuOpen.set(false);
    const doc = this.doc();
    const title = this.board()?.title ?? '';
    switch (entry.id) {
      case 'history':
        this.historyOpen.set(true);
        break;
      case 'about':
        this.aboutOpen.set(true);
        break;
      case 'export':
        if (doc) {
          this.transfer.exportFile(doc, title);
        }
        break;
      case 'link':
        if (doc) {
          await this.transfer.copyLink(doc, title);
        }
        break;
      case 'import':
        this.fileInput()?.nativeElement.click();
        break;
      case 'saveTemplate':
        await this.saveAsTemplate();
        break;
      case 'template':
        await this.toggleTemplate();
        break;
    }
  }

  /** A copy of this board with the template flag; this board stays as it is. */
  private async saveAsTemplate(): Promise<void> {
    const board = this.board();
    if (!board || this.savingTemplate()) {
      return;
    }
    this.savingTemplate.set(true);
    try {
      const summary = await this.templates.fileSummary(board);
      if (summary.count > 0) {
        this.askingFiles.set(summary);
        return;
      }
      await this.templates.saveAsTemplate(board, this.doc());
    } finally {
      this.savingTemplate.set(false);
    }
  }

  /** The answer to "copy files too?" for Save as template. */
  @WithSpan('BoardTitleBar.answerFiles')
  protected async answerFiles(withFiles: boolean): Promise<void> {
    const board = this.board();
    this.askingFiles.set(undefined);
    if (!board) {
      return;
    }
    this.savingTemplate.set(true);
    try {
      await this.templates.saveAsTemplate(board, this.doc(), { files: withFiles });
    } finally {
      this.savingTemplate.set(false);
    }
  }

  @WithSpan('BoardTitleBar.cancelFiles')
  protected cancelFiles(): void {
    this.askingFiles.set(undefined);
  }

  /** The owner's switch: this board is (no longer) offered as a template. */
  private async toggleTemplate(): Promise<void> {
    const board = this.board();
    if (!board || board.role !== BoardRole.OWNER) {
      return;
    }
    const changed = await this.actions.setTemplate(board, !board.template);
    if (changed) {
      this.toasts.success(
        changed.template ? 'This board is a template now.' : 'This board is no longer a template.',
      );
    }
    // also after a failure (409: someone changed the board): show the current state
    this.changed.emit();
  }

  /** A file was picked: import it as a new board (opens it when done). */
  @WithSpan('BoardTitleBar.importPicked')
  protected async importPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.importing()) {
      return;
    }
    this.importing.set(true);
    try {
      await this.transfer.importFile(file);
    } finally {
      this.importing.set(false);
    }
  }

  @WithSpan('BoardTitleBar.closeHistory')
  protected closeHistory(): void {
    this.historyOpen.set(false);
  }

  @WithSpan('BoardTitleBar.closeAbout')
  protected closeAbout(): void {
    this.aboutOpen.set(false);
  }

  @WithSpan('BoardTitleBar.closeMenu')
  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** The submission action of the title form - the user action "rename the board", a span. */
  @WithSpan('BoardTitleBar.rename')
  private async rename(field: FieldTree<TitleDraft>): Promise<TreeValidationResult> {
    const board = this.board();
    if (!board) {
      return undefined;
    }
    const context = new HttpContext().set(FIELD_ERRORS_HANDLED_LOCALLY, true);
    try {
      // started before the first await: BoardActions' span becomes a child of this one
      await this.actions.rename(board, field().value().title.trim(), context);
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
        return violationsToFieldErrors(field, error.violations);
      }
      throw error;
    }
  }
}
