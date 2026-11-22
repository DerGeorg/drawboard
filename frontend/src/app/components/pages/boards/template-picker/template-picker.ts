import { Component, inject, model, signal } from '@angular/core';
import { HttpContext } from '@angular/common/http';
import { Board, BoardsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { type BuiltinTemplate, loadBuiltinTemplates } from '@apps/drawboard-engine';
import { ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { ErrorMessages } from '../../../../services/error-messages';
import { ApiError } from '../../../../util/api-error';
import { relativeTime } from '../../../../util/relative-time';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { TemplateOwners } from '../template-owners';
import { TemplatePreview } from '../template-preview/template-preview';

/** What a new board starts from. */
export type TemplateChoice =
  | { readonly kind: 'empty' }
  | { readonly kind: 'builtin'; readonly template: BuiltinTemplate }
  | { readonly kind: 'board'; readonly board: Board };

export const EMPTY_CHOICE: TemplateChoice = { kind: 'empty' };

/** The title a choice gives the new board; undefined for the empty board. */
export function choiceTitle(choice: TemplateChoice): string | undefined {
  switch (choice.kind) {
    case 'builtin':
      return choice.template.title;
    case 'board':
      return choice.board.title;
    default:
      return undefined;
  }
}

/**
 * The "start from" part of the new-board dialog: an empty board, the built-in templates (their
 * own lazy chunk) and the templates of the user's library (`listTemplates`: own and shared, one
 * page at a time with "Load more"). One radio group; the choice is a two-way `model`.
 */
@Component({
  selector: 'drawboard-template-picker',
  imports: [Icon, TemplatePreview],
  templateUrl: './template-picker.html',
})
export class TemplatePicker {
  static readonly pageSize = 12;

  private readonly boardsApi = inject(BoardsService);
  private readonly messages = inject(ErrorMessages);
  protected readonly owners = inject(TemplateOwners);
  /** A failed list is shown here (a 429 gets its friendly text), not as a toast. */
  private readonly context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

  readonly choice = model<TemplateChoice>(EMPTY_CHOICE);

  protected readonly builtin = signal<readonly BuiltinTemplate[]>([]);
  protected readonly templates = signal<readonly Board[]>([]);
  protected readonly loading = signal(false);
  protected readonly failed = signal<string | undefined>(undefined);
  protected readonly hasMore = signal(false);
  protected readonly loaded = signal(false);
  private nextPage = 0;

  constructor() {
    void loadBuiltinTemplates().then((list) => this.builtin.set(list));
    void this.loadMore();
  }

  /** The next page of the user's templates. */
  @WithSpan('TemplatePicker.loadMore')
  protected async loadMore(): Promise<void> {
    if (this.loading()) {
      return;
    }
    this.loading.set(true);
    this.failed.set(undefined);
    try {
      const page = await firstValueFrom(
        this.boardsApi.listTemplates(
          { page: this.nextPage, size: TemplatePicker.pageSize },
          'body',
          false,
          { context: this.context },
        ),
      );
      this.templates.update((all) => [...all, ...page.items]);
      this.nextPage = page.page.number + 1;
      this.hasMore.set(this.nextPage < page.page.totalPages);
      this.loaded.set(true);
      void this.owners.resolve(page.items);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      this.failed.set(this.messages.text(error.problem));
    } finally {
      this.loading.set(false);
    }
  }

  @WithSpan('TemplatePicker.select')
  protected select(choice: TemplateChoice): void {
    this.choice.set(choice);
  }

  protected isEmpty(): boolean {
    return this.choice().kind === 'empty';
  }

  protected isBuiltin(template: BuiltinTemplate): boolean {
    const choice = this.choice();
    return choice.kind === 'builtin' && choice.template.id === template.id;
  }

  protected isBoard(board: Board): boolean {
    const choice = this.choice();
    return choice.kind === 'board' && choice.board.id === board.id;
  }

  protected edited(board: Board): string {
    return relativeTime(board.updatedAt);
  }
}
