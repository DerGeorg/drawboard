import { Service, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Folder, FoldersService } from '@apps/drawboard-api';

import { FolderNode, buildFolderTree } from '../../../util/folder-tree';

/**
 * The signed-in user's own folders as one signal state shared by the sidebar tree, the folder
 * picker and the library page (one request, `reload()` after every change).
 */
@Service()
export class LibraryFolders {
  private readonly foldersApi = inject(FoldersService);

  readonly resource = rxResource({ stream: () => this.foldersApi.listFolders({}) });

  readonly folders = computed<readonly Folder[]>(() =>
    this.resource.hasValue() ? this.resource.value().items : [],
  );
  readonly tree = computed<FolderNode[]>(() => buildFolderTree(this.folders()));

  reload(): void {
    this.resource.reload();
  }

  byId(id: string | null | undefined): Folder | undefined {
    return id ? this.folders().find((f) => f.id === id) : undefined;
  }
}
