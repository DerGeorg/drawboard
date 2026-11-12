import { Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { BoardsService } from '@apps/drawboard-api';

import { pageIndexFromQuery } from '../../../../util/page-number';
import { DgLogo } from '../../../shared/dg-logo/dg-logo';
import { Icon } from '../../../shared/icon/icon';
import { LoadError } from '../../../shared/load-error/load-error';
import { Pager } from '../../../shared/pager/pager';
import { RoleBadge } from '../../../shared/role-badge/role-badge';
import { GuestBadge } from '../guest-badge/guest-badge';
import { RouterLink } from '@angular/router';
import { GuestMadeWith } from '../guest-made-with/guest-made-with';

/**
 * /s/f/:folderId - what a guest sees of a shared folder: the boards directly in it (the only
 * listing the API allows guests - no subfolders, no folder name, no library). Each board opens
 * in the guest editor. Guests only: the route is behind guestGuard.
 */
@Component({
  selector: 'drawboard-guest-folder',
  imports: [DgLogo, GuestBadge, GuestMadeWith, Icon, LoadError, Pager, RoleBadge, RouterLink],
  templateUrl: './guest-folder.html',
})
export class GuestFolder {
  static readonly pageSize = 12;

  private readonly boardsApi = inject(BoardsService);

  /** Route parameter (withComponentInputBinding). */
  readonly folderId = input.required<string>();
  readonly page = input(0, { transform: pageIndexFromQuery });

  protected readonly boards = rxResource({
    params: () => ({ folderId: this.folderId(), page: this.page(), size: GuestFolder.pageSize }),
    stream: ({ params }) => this.boardsApi.listBoards(params),
  });

  protected readonly items = computed(() =>
    this.boards.hasValue()
      ? [...this.boards.value().items].sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        )
      : [],
  );
}
