import { Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Board, BoardsService, Folder } from '@apps/drawboard-api';

import { relativeTime } from '../../../../util/relative-time';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { LoadError } from '../../../shared/load-error/load-error';
import { BoardActions } from '../board-actions';
import { FolderActions } from '../folder-actions';
import { LibraryFolders } from '../library-folders';

/** One row: a board or a folder in the trash. */
interface TrashEntry {
  readonly key: string;
  readonly kind: 'board' | 'folder';
  readonly title: string;
  readonly deletedAt: string;
  readonly board?: Board;
  readonly folder?: Folder;
}

/** Days after which the server purges what is in the trash (architecture S7.7). */
export const TRASH_DAYS = 30;

/**
 * The trash: the user's deleted boards and folders (a folder deleted with its content is one
 * entry), most recently deleted first. Restore puts them back; "Delete forever" asks for a
 * confirmation first because it cannot be undone. The server purges entries after 30 days.
 */
@Component({
  selector: 'drawboard-trash-list',
  imports: [Icon, LoadError],
  templateUrl: './trash-list.html',
})
export class TrashList {
  private readonly boardsApi = inject(BoardsService);
  private readonly boardActions = inject(BoardActions);
  private readonly folderActions = inject(FolderActions);
  private readonly library = inject(LibraryFolders);

  protected readonly trash = rxResource({ stream: () => this.boardsApi.listTrash() });
  /** Key of the entry that asks "delete forever?" right now. */
  protected readonly confirming = signal<string | undefined>(undefined);
  protected readonly busy = signal(false);

  protected readonly entries = computed<TrashEntry[]>(() => {
    if (!this.trash.hasValue()) {
      return [];
    }
    const { boards, folders } = this.trash.value();
    return [
      ...boards.map<TrashEntry>((board) => ({
        key: `board-${board.id}`,
        kind: 'board',
        title: board.title,
        deletedAt: board.deletedAt ?? board.updatedAt,
        board,
      })),
      ...folders.map<TrashEntry>((folder) => ({
        key: `folder-${folder.id}`,
        kind: 'folder',
        title: folder.name,
        deletedAt: folder.deletedAt ?? folder.updatedAt,
        folder,
      })),
    ].sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  });

  protected deleted(entry: TrashEntry): string {
    return relativeTime(entry.deletedAt);
  }

  /** Whole days left before the server purges the entry (at least 0). */
  protected daysLeft(entry: TrashEntry): number {
    const left = Date.parse(entry.deletedAt) + TRASH_DAYS * 86_400_000 - Date.now();
    return Math.max(0, Math.ceil(left / 86_400_000));
  }

  @WithSpan('TrashList.ask')
  protected ask(entry: TrashEntry): void {
    this.confirming.set(entry.key);
  }

  @WithSpan('TrashList.cancel')
  protected cancel(): void {
    this.confirming.set(undefined);
  }

  @WithSpan('TrashList.restore')
  protected async restore(entry: TrashEntry): Promise<void> {
    await this.run(entry, 'restore');
  }

  @WithSpan('TrashList.purge')
  protected async purge(entry: TrashEntry): Promise<void> {
    await this.run(entry, 'purge');
  }

  private async run(entry: TrashEntry, command: 'restore' | 'purge'): Promise<void> {
    this.busy.set(true);
    try {
      const done = entry.board
        ? await this.boardActions[command](entry.board)
        : await this.folderActions[command](entry.folder as Folder);
      if (done) {
        this.trash.reload();
        if (entry.folder) {
          // the restored folder is back in the tree
          this.library.reload();
        }
      }
    } finally {
      this.busy.set(false);
      this.confirming.set(undefined);
    }
  }
}
