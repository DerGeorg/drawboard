import { Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  Board,
  BoardRole,
  BoardsService,
  Folder,
  FoldersService,
  SharingService,
} from '@apps/drawboard-api';

import { pageIndexFromQuery } from '../../../../util/page-number';
import { WithSpan } from '../../../../util/tracing';
import { LibraryShell, LibraryView } from '../../../layout/library-shell/library-shell';
import { LoadError } from '../../../shared/load-error/load-error';
import { Pager } from '../../../shared/pager/pager';
import { BoardCard } from '../board-card/board-card';
import { BoardCreate } from '../board-create/board-create';
import { BoardMover } from '../board-mover';
import { NewBoardDialog } from '../new-board-dialog/new-board-dialog';
import { TemplateList } from '../template-list/template-list';
import { FolderCard } from '../folder-card/folder-card';
import { FolderTree } from '../folder-tree/folder-tree';
import { LibraryFolders } from '../library-folders';
import { TrashList } from '../trash-list/trash-list';

const VIEWS: readonly LibraryView[] = ['recent', 'mine', 'shared', 'templates', 'trash'];

/** Query parameter ?view=: anything unknown is the recent view. */
function viewFromQuery(value: unknown): LibraryView {
  return VIEWS.find((v) => v === value) ?? 'recent';
}

/** Query parameter ?folder=: a non-empty id or nothing. */
function folderFromQuery(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * /boards?view=recent|mine|shared|templates|trash&folder=ID&page=N - the library inside the library
 * shell. Recent is the top level of the user's space by last edit; My boards shows the folders
 * and boards of the open folder (the sidebar tree switches folders); Shared with me lists what
 * others shared - a shared folder opens like a folder of one's own; Templates lists the built-in
 * templates and the template boards the user can open; Trash is its own list.
 * The search field filters what is loaded (client-side).
 */
@Component({
  selector: 'drawboard-board-list',
  imports: [
    BoardCard,
    BoardCreate,
    FolderCard,
    FolderTree,
    LibraryShell,
    LoadError,
    NewBoardDialog,
    Pager,
    RouterLink,
    TemplateList,
    TrashList,
  ],
  templateUrl: './board-list.html',
})
export class BoardList {
  static readonly pageSize = 12;

  private readonly boardsApi = inject(BoardsService);
  private readonly foldersApi = inject(FoldersService);
  private readonly sharingApi = inject(SharingService);
  private readonly library = inject(LibraryFolders);
  protected readonly mover = inject(BoardMover);

  /** Zero-based page from the query parameter ?page= (1-based in the URL). */
  readonly page = input(0, { transform: pageIndexFromQuery });
  readonly view = input<LibraryView, unknown>('recent', { transform: viewFromQuery });
  readonly folder = input<string | undefined, unknown>(undefined, { transform: folderFromQuery });

  protected readonly search = signal('');
  /** The "New board" dialog is open. */
  protected readonly creating = signal(false);

  /** The open folder (heading, role, parent) - also for folders of others (shared). */
  protected readonly folderInfo = rxResource({
    params: () =>
      this.folder() && this.view() !== 'trash' ? { folderId: this.folder()! } : undefined,
    stream: ({ params }) => this.foldersApi.getFolder(params),
  });
  protected readonly openFolder = computed<Folder | undefined>(() =>
    this.folderInfo.hasValue() ? this.folderInfo.value() : undefined,
  );

  /** One page of boards: the top level, or the boards of the open folder. */
  protected readonly boards = rxResource({
    params: () => {
      const view = this.view();
      const folderId = this.folder();
      if (view === 'trash' || view === 'templates' || (view === 'shared' && !folderId)) {
        return undefined;
      }
      // `moves` makes the listing reload after a board was moved by drag and drop
      return { folderId, page: this.page(), size: BoardList.pageSize, moves: this.mover.moves() };
    },
    stream: ({ params: { folderId, page, size } }) =>
      this.boardsApi.listBoards({ folderId, page, size }),
  });

  /** What others shared with the user (top level of the Shared view). */
  protected readonly shared = rxResource({
    params: () =>
      this.view() === 'shared' && !this.folder() ? { moves: this.mover.moves() } : undefined,
    stream: () => this.sharingApi.listSharedWithMe(),
  });

  /** Subfolders of a shared folder (own folders come from the shared tree state). */
  private readonly sharedSubfolders = rxResource({
    params: () =>
      this.view() === 'shared' && this.folder() ? { parentId: this.folder()! } : undefined,
    stream: ({ params }) => this.foldersApi.listFolders(params),
  });

  protected readonly heading = computed(() => {
    const folder = this.openFolder();
    switch (this.view()) {
      case 'mine':
        return folder?.name ?? 'My boards';
      case 'shared':
        return folder?.name ?? 'Shared with me';
      case 'templates':
        return 'Templates';
      case 'trash':
        return 'Trash';
      default:
        return 'Recent';
    }
  });

  /** Where "Up" leads from an open folder. */
  protected readonly upQuery = computed(() => {
    const parent = this.openFolder()?.parentId;
    return this.view() === 'mine' && parent
      ? { view: 'mine', folder: parent }
      : { view: this.view() };
  });

  /** Boards can only be created in the user's own space: top level or an own folder. */
  protected readonly canCreate = computed(() => {
    const view = this.view();
    if (view === 'shared' || view === 'trash') {
      return false;
    }
    if (view === 'templates') {
      return true; // the top level: new boards from a template land there
    }
    return !this.folder() || this.openFolder()?.role === BoardRole.OWNER;
  });
  protected readonly newBoardFolder = computed(() =>
    this.view() === 'mine' ? this.folder() : undefined,
  );

  private readonly needle = computed(() => this.search().trim().toLowerCase());

  /** Folders shown in the grid under the current view, folder and search text. */
  protected readonly folders = computed<Folder[]>(() => {
    const view = this.view();
    const folderId = this.folder();
    let list: readonly Folder[] = [];
    if (view === 'mine') {
      list = this.library.folders().filter((f) => (f.parentId ?? undefined) === folderId);
    } else if (view === 'shared') {
      if (folderId) {
        list = this.sharedSubfolders.hasValue() ? this.sharedSubfolders.value().items : [];
      } else {
        list = this.shared.hasValue() ? this.shared.value().folders : [];
      }
    }
    return list
      .filter((f) => this.needle() === '' || f.name.toLowerCase().includes(this.needle()))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /** What the loaded boards show under the current view and search text. */
  protected readonly visible = computed<Board[]>(() => {
    const source: readonly Board[] = this.sharedTopLevel()
      ? this.shared.hasValue()
        ? this.shared.value().boards
        : []
      : this.boards.hasValue()
        ? this.boards.value().items
        : [];
    return source
      .filter((b) => this.needle() === '' || b.title.toLowerCase().includes(this.needle()))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  });

  /** The top level of "Shared with me" has its own listing; everything else is a page of boards. */
  private readonly sharedTopLevel = computed(() => this.view() === 'shared' && !this.folder());
  protected readonly error = computed(() =>
    this.sharedTopLevel() ? this.shared.error() : this.boards.error(),
  );
  protected readonly busy = computed(() =>
    this.sharedTopLevel() ? this.shared.isLoading() : this.boards.isLoading(),
  );
  protected readonly ready = computed(
    () =>
      (this.sharedTopLevel() ? this.shared.hasValue() : this.boards.hasValue()) &&
      (this.view() !== 'mine' || this.library.resource.hasValue()),
  );
  /** Paging info of the listing, if it is paged. */
  protected readonly pageInfo = computed(() =>
    !this.sharedTopLevel() && this.boards.hasValue() ? this.boards.value().page : undefined,
  );

  @WithSpan('BoardList.dropOnRoot')
  protected dropOnRoot(): void {
    void this.mover.drop(null, 'My boards');
  }

  @WithSpan('BoardList.openCreate')
  protected openCreate(): void {
    this.creating.set(true);
  }

  @WithSpan('BoardList.closeCreate')
  protected closeCreate(): void {
    this.creating.set(false);
  }

  @WithSpan('BoardList.reload')
  protected reload(): void {
    if (this.sharedTopLevel()) {
      this.shared.reload();
    } else {
      this.boards.reload();
    }
  }
}
