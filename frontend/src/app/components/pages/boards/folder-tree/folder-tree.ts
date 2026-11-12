import { Component, inject, input, signal } from '@angular/core';

import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { NameForm } from '../../../shared/name-form/name-form';
import { FolderActions } from '../folder-actions';
import { FolderTreeNode } from '../folder-tree-node/folder-tree-node';
import { LibraryFolders } from '../library-folders';

/**
 * The sidebar's tree of the user's own folders (below "My boards"): a header with "New
 * folder" and the nested folders. A folder opens its boards in the library; board cards can be
 * dropped onto it.
 */
@Component({
  selector: 'drawboard-folder-tree',
  imports: [FolderTreeNode, Icon, NameForm],
  templateUrl: './folder-tree.html',
  // block: a custom element is inline by default and ignores the margin set by the sidebar
  host: { class: 'block' },
})
export class FolderTree {
  private readonly actions = inject(FolderActions);
  protected readonly library = inject(LibraryFolders);

  /** The folder open in the library right now. */
  readonly active = input<string | undefined>();

  protected readonly creating = signal(false);

  @WithSpan('FolderTree.startCreate')
  protected startCreate(): void {
    this.creating.set(true);
  }

  @WithSpan('FolderTree.stopCreate')
  protected stopCreate(): void {
    this.creating.set(false);
  }

  @WithSpan('FolderTree.create')
  protected async create(name: string): Promise<void> {
    try {
      await this.actions.create(name);
      this.library.reload();
    } catch (error) {
      // already toasted by the error interceptor; the list may be out of date (409)
      if (!(error instanceof ApiError)) {
        throw error;
      }
      this.library.reload();
    } finally {
      this.creating.set(false);
    }
  }
}
