import { Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Folder } from '@apps/drawboard-api';

import { ApiError } from '../../../../util/api-error';
import { FolderNode, subtreeIds } from '../../../../util/folder-tree';
import { WithSpan } from '../../../../util/tracing';
import { ActionMenu } from '../../../shared/action-menu/action-menu';
import { Icon } from '../../../shared/icon/icon';
import { NameForm } from '../../../shared/name-form/name-form';
import { BoardMover } from '../board-mover';
import { FolderActions } from '../folder-actions';
import { FolderPicker } from '../folder-picker/folder-picker';
import { LibraryFolders } from '../library-folders';
import { ShareDialog } from '../share-dialog/share-dialog';

type Mode = 'idle' | 'rename' | 'child' | 'delete' | 'move' | 'share';

/**
 * One folder of the sidebar tree and, recursively, its subfolders: a link to the folder, a
 * menu (new subfolder, rename, move to…, delete to the trash) and a drop target for board
 * cards. Changes reload the shared folder list.
 */
@Component({
  selector: 'drawboard-folder-tree-node',
  imports: [RouterLink, ActionMenu, FolderPicker, Icon, NameForm, ShareDialog],
  templateUrl: './folder-tree-node.html',
})
export class FolderTreeNode {
  private readonly actions = inject(FolderActions);
  private readonly library = inject(LibraryFolders);
  private readonly mover = inject(BoardMover);

  readonly node = input.required<FolderNode>();
  /** The folder open in the library right now. */
  readonly active = input<string | undefined>();
  readonly depth = input(0);

  protected readonly mode = signal<Mode>('idle');
  protected readonly expanded = signal(true);
  protected readonly dropHover = signal(false);

  protected readonly folder = computed(() => this.node().folder);
  /** The folder and everything below it: not valid targets for "Move to…". */
  protected readonly excluded = computed(() => subtreeIds(this.library.tree(), this.folder().id));
  protected readonly isActive = computed(() => this.active() === this.folder().id);

  @WithSpan('FolderTreeNode.setMode')
  protected setMode(mode: Mode): void {
    this.mode.set(mode);
    if (mode === 'child') {
      this.expanded.set(true);
    }
  }

  @WithSpan('FolderTreeNode.toggle')
  protected toggle(): void {
    this.expanded.update((value) => !value);
  }

  @WithSpan('FolderTreeNode.allowDrop')
  protected allowDrop(event: DragEvent): void {
    if (this.mover.dragged()) {
      event.preventDefault();
      this.dropHover.set(true);
    }
  }

  @WithSpan('FolderTreeNode.drop')
  protected async drop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dropHover.set(false);
    await this.mover.drop(this.folder().id, this.folder().name);
  }

  @WithSpan('FolderTreeNode.rename')
  protected async rename(name: string): Promise<void> {
    try {
      await this.actions.rename(this.folder(), name);
      this.library.reload();
    } catch (error) {
      // already toasted by the error interceptor; the list may be out of date (409)
      if (!(error instanceof ApiError)) {
        throw error;
      }
      this.library.reload();
    } finally {
      this.mode.set('idle');
    }
  }

  @WithSpan('FolderTreeNode.createChild')
  protected async createChild(name: string): Promise<void> {
    try {
      await this.actions.create(name, this.folder().id);
      this.library.reload();
    } catch (error) {
      // already toasted by the error interceptor; the list may be out of date (409)
      if (!(error instanceof ApiError)) {
        throw error;
      }
      this.library.reload();
    } finally {
      this.mode.set('idle');
    }
  }

  @WithSpan('FolderTreeNode.move')
  protected async move(parentId: string | null): Promise<void> {
    this.mode.set('idle');
    if (await this.actions.move(this.folder(), parentId)) {
      this.library.reload();
    }
  }

  @WithSpan('FolderTreeNode.remove', {
    attributes: (folder: Folder) => ({ 'folder.id': folder.id }),
  })
  protected async remove(folder: Folder): Promise<void> {
    this.mode.set('idle');
    if (await this.actions.delete(folder)) {
      this.library.reload();
    }
  }
}
