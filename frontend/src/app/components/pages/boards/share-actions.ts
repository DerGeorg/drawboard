import { HttpContext } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { CreatedShareLink, GrantRole, NewShareLink, SharingService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { Toasts } from '../../../services/toasts';
import { ApiError } from '../../../util/api-error';
import { WithSpan } from '../../../util/tracing';
import { ShareKind } from './share-target';

/**
 * The commands of the share dialog. Spans carry ids only - never names, group names, passwords
 * or link URLs. Member commands and revoking resolve to whether they worked (failures are
 * already toasted by the error interceptor); createLink re-throws the ApiError so the form can
 * show violations at its fields.
 */
@Service()
export class ShareActions {
  private readonly sharingApi = inject(SharingService);
  private readonly toasts = inject(Toasts);

  @WithSpan('ShareActions.setUserRole', {
    attributes: (_kind: ShareKind, id: string) => ({ 'resource.id': id }),
  })
  setUserRole(kind: ShareKind, id: string, userId: string, role: GrantRole): Promise<boolean> {
    const memberUpdate = { role };
    return this.succeeded(
      firstValueFrom(
        kind === 'board'
          ? this.sharingApi.setBoardUserMember({ boardId: id, userId, memberUpdate })
          : this.sharingApi.setFolderUserMember({ folderId: id, userId, memberUpdate }),
      ),
    );
  }

  @WithSpan('ShareActions.setGroupRole', {
    attributes: (_kind: ShareKind, id: string) => ({ 'resource.id': id }),
  })
  setGroupRole(kind: ShareKind, id: string, group: string, role: GrantRole): Promise<boolean> {
    const memberUpdate = { role };
    return this.succeeded(
      firstValueFrom(
        kind === 'board'
          ? this.sharingApi.setBoardGroupMember({ boardId: id, group, memberUpdate })
          : this.sharingApi.setFolderGroupMember({ folderId: id, group, memberUpdate }),
      ),
    );
  }

  @WithSpan('ShareActions.removeUser', {
    attributes: (_kind: ShareKind, id: string) => ({ 'resource.id': id }),
  })
  removeUser(kind: ShareKind, id: string, userId: string): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(
        kind === 'board'
          ? this.sharingApi.removeBoardUserMember({ boardId: id, userId })
          : this.sharingApi.removeFolderUserMember({ folderId: id, userId }),
      ),
    );
  }

  @WithSpan('ShareActions.removeGroup', {
    attributes: (_kind: ShareKind, id: string) => ({ 'resource.id': id }),
  })
  removeGroup(kind: ShareKind, id: string, group: string): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(
        kind === 'board'
          ? this.sharingApi.removeBoardGroupMember({ boardId: id, group })
          : this.sharingApi.removeFolderGroupMember({ folderId: id, group }),
      ),
    );
  }

  /** Creates a link; the answer carries the URL with the token - shown once, never stored. */
  @WithSpan('ShareActions.createLink', {
    attributes: (_kind: ShareKind, id: string) => ({ 'resource.id': id }),
  })
  createLink(
    kind: ShareKind,
    id: string,
    newShareLink: NewShareLink,
    context?: HttpContext,
  ): Promise<CreatedShareLink> {
    return firstValueFrom(
      kind === 'board'
        ? this.sharingApi.createBoardShareLink({ boardId: id, newShareLink }, 'body', false, {
            context,
          })
        : this.sharingApi.createFolderShareLink({ folderId: id, newShareLink }, 'body', false, {
            context,
          }),
    );
  }

  @WithSpan('ShareActions.revokeLink', { attributes: (linkId: string) => ({ 'link.id': linkId }) })
  revokeLink(linkId: string): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.sharingApi.revokeShareLink({ linkId })),
      'The link was revoked.',
    );
  }

  private async succeeded(call: Promise<unknown>, message?: string): Promise<boolean> {
    try {
      await call;
      if (message) {
        this.toasts.success(message);
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        return false;
      }
      throw error;
    }
  }
}
