import { Component, computed, inject, input, output } from '@angular/core';

import { FolderNode, flattenFolderTree } from '../../../../util/folder-tree';
import { WithSpan } from '../../../../util/tracing';
import { LibraryFolders } from '../library-folders';
import { Icon } from '../../../shared/icon/icon';
import { Modal } from '../../../shared/modal/modal';

/**
 * "Move to…": a dialog listing the user's own folders (and the top level) as a tree. Picking
 * one emits `picked` (null = the top level); the folders in `excluded` and the `current` place
 * are shown disabled (a folder cannot move into itself or below).
 */
@Component({
  selector: 'drawboard-folder-picker',
  imports: [Icon, Modal],
  templateUrl: './folder-picker.html',
})
export class FolderPicker {
  private readonly library = inject(LibraryFolders);

  readonly heading = input('Move to…');
  /** The place the item is in now (null = top level); shown as "current". */
  readonly current = input<string | null>(null);
  /** Folder ids that are not valid targets (a folder and everything below it). */
  readonly excluded = input<ReadonlySet<string>>(new Set());
  readonly picked = output<string | null>();
  readonly closed = output();

  protected readonly rows = computed(() =>
    flattenFolderTree(this.library.tree() as readonly FolderNode[]),
  );

  @WithSpan('FolderPicker.pick')
  protected pick(folderId: string | null): void {
    this.picked.emit(folderId);
  }
}
