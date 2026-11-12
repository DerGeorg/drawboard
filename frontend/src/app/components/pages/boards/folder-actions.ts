import { HttpContext } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { Folder, FoldersService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { Toasts } from '../../../services/toasts';
import { ApiError } from '../../../util/api-error';
import { WithSpan } from '../../../util/tracing';

/**
 * The commands of the folder tree (same conventions as BoardActions: every public method is a
 * span with ids only, never names). create/rename re-throw the ApiError so the caller can show
 * violations at its field; the others resolve to whether they worked (failures are already
 * toasted by the error interceptor).
 */
@Service()
export class FolderActions {
  private readonly foldersApi = inject(FoldersService);
  private readonly toasts = inject(Toasts);

  @WithSpan('FolderActions.create')
  create(name: string, parentId?: string, context?: HttpContext): Promise<Folder> {
    return firstValueFrom(
      this.foldersApi.createFolder({ newFolder: { name, parentId } }, 'body', false, { context }),
    );
  }

  /** Optimistic locking with `folder.version`; a newer one answers 409. */
  @WithSpan('FolderActions.rename', {
    attributes: (folder: Folder) => ({ 'folder.id': folder.id }),
  })
  rename(folder: Folder, name: string, context?: HttpContext): Promise<Folder> {
    return firstValueFrom(
      this.foldersApi.updateFolder(
        {
          folderId: folder.id,
          folderUpdate: { name, parentId: folder.parentId, version: folder.version },
        },
        'body',
        false,
        { context },
      ),
    );
  }

  /** Moves the folder below another one (null = the root); LIBRARY_FOLDER_CYCLE is toasted. */
  @WithSpan('FolderActions.move', { attributes: (folder: Folder) => ({ 'folder.id': folder.id }) })
  async move(folder: Folder, parentId: string | null): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(
        this.foldersApi.updateFolder({
          folderId: folder.id,
          folderUpdate: { name: folder.name, parentId, version: folder.version },
        }),
      ),
      `"${folder.name}" was moved.`,
    );
  }

  /** Moves the folder with everything in it to the trash. */
  @WithSpan('FolderActions.delete', {
    attributes: (folder: Folder) => ({ 'folder.id': folder.id }),
  })
  delete(folder: Folder): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.foldersApi.deleteFolder({ folderId: folder.id })),
      `"${folder.name}" was moved to the trash.`,
    );
  }

  @WithSpan('FolderActions.restore', {
    attributes: (folder: Folder) => ({ 'folder.id': folder.id }),
  })
  restore(folder: Folder): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.foldersApi.restoreFolder({ folderId: folder.id })),
      `"${folder.name}" was restored.`,
    );
  }

  /** Deletes a folder in the trash with everything below it for good. */
  @WithSpan('FolderActions.purge', { attributes: (folder: Folder) => ({ 'folder.id': folder.id }) })
  purge(folder: Folder): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.foldersApi.purgeFolder({ folderId: folder.id })),
      `"${folder.name}" was deleted for good.`,
    );
  }

  private async succeeded(call: Promise<unknown>, message: string): Promise<boolean> {
    try {
      await call;
      this.toasts.success(message);
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        return false;
      }
      throw error;
    }
  }
}
