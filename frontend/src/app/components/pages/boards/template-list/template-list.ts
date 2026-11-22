import { HttpContext } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Board, BoardsService } from '@apps/drawboard-api';

import { type BuiltinTemplate, loadBuiltinTemplates } from '@apps/drawboard-engine';
import { ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { WithSpan } from '../../../../util/tracing';
import { LoadError } from '../../../shared/load-error/load-error';
import { Pager } from '../../../shared/pager/pager';
import { BoardTemplates, FileSummary } from '../board-templates';
import { TemplateCard } from '../template-card/template-card';
import { TemplateFilesDialog } from '../template-files-dialog/template-files-dialog';
import { TemplateOwners } from '../template-owners';
import { TemplatePreview } from '../template-preview/template-preview';

/**
 * The Templates page of the library (`?view=templates`): the templates built into the frontend
 * and the templates the user can open (own and shared, `listTemplates`, paged through ?page=).
 * "Use" makes a new board as a copy in the top level of the user's space and opens it; "Open"
 * goes to a template board itself. `search` filters the loaded page by title.
 */
@Component({
  selector: 'drawboard-template-list',
  imports: [LoadError, Pager, TemplateCard, TemplateFilesDialog, TemplatePreview],
  templateUrl: './template-list.html',
})
export class TemplateList {
  static readonly pageSize = 12;

  private readonly boardsApi = inject(BoardsService);
  private readonly templates = inject(BoardTemplates);
  private readonly router = inject(Router);
  private readonly owners = inject(TemplateOwners);
  /** A failed list is shown by the alert (a 429 with its friendly text), not as a toast. */
  private readonly context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

  /** Zero-based page. */
  readonly page = input(0);
  readonly search = input('');

  protected readonly builtin = signal<readonly BuiltinTemplate[]>([]);
  /** Key of the template that is being copied right now (one at a time). */
  protected readonly busy = signal<string | undefined>(undefined);

  /** A template with files waits here for the answer to "copy files too?". */
  protected readonly asking = signal<{ board: Board; summary: FileSummary } | undefined>(undefined);

  protected readonly list = rxResource({
    params: () => ({ page: this.page() }),
    stream: ({ params }) =>
      this.boardsApi.listTemplates(
        { page: params.page, size: TemplateList.pageSize },
        'body',
        false,
        {
          context: this.context,
        },
      ),
  });

  private readonly needle = computed(() => this.search().trim().toLowerCase());

  protected readonly visibleBuiltin = computed(() =>
    this.builtin().filter((t) => this.matches(t.title)),
  );
  protected readonly visible = computed<Board[]>(() =>
    this.list.hasValue() ? this.list.value().items.filter((b) => this.matches(b.title)) : [],
  );
  protected readonly pageInfo = computed(() =>
    this.list.hasValue() ? this.list.value().page : undefined,
  );

  constructor() {
    void loadBuiltinTemplates().then((list) => this.builtin.set(list));
    effect(() => {
      if (this.list.hasValue()) {
        void this.owners.resolve(this.list.value().items);
      }
    });
  }

  private matches(title: string): boolean {
    return this.needle() === '' || title.toLowerCase().includes(this.needle());
  }

  @WithSpan('TemplateList.useBuiltin')
  protected async useBuiltin(template: BuiltinTemplate): Promise<void> {
    await this.use(`builtin-${template.id}`, () => this.templates.fromBuiltin(template));
  }

  @WithSpan('TemplateList.useBoard', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  protected async useBoard(board: Board): Promise<void> {
    if (this.busy()) {
      return;
    }
    const summary = await this.templates.fileSummary(board);
    if (summary.count > 0) {
      this.asking.set({ board, summary });
      return;
    }
    await this.copyBoard(board, true);
  }

  /** The answer to "copy files too?". */
  @WithSpan('TemplateList.answer')
  protected async answer(withFiles: boolean): Promise<void> {
    const asked = this.asking();
    this.asking.set(undefined);
    if (asked) {
      await this.copyBoard(asked.board, withFiles);
    }
  }

  @WithSpan('TemplateList.cancelAsking')
  protected cancelAsking(): void {
    this.asking.set(undefined);
  }

  private copyBoard(board: Board, files: boolean): Promise<void> {
    return this.use(`board-${board.id}`, () => this.templates.fromBoard(board, { files }));
  }

  @WithSpan('TemplateList.reload')
  protected reload(): void {
    this.list.reload();
  }

  private async use(key: string, make: () => Promise<Board | undefined>): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(key);
    try {
      const board = await make();
      if (board) {
        await this.router.navigate(['/boards', board.id]);
      }
    } finally {
      this.busy.set(undefined);
    }
  }
}
