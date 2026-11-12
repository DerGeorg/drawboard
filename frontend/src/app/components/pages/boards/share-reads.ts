import { Service, inject } from '@angular/core';
import {
  MemberList,
  ShareLinkList,
  SharingService,
  UserSummaryList,
  UsersService,
} from '@apps/drawboard-api';
import { Observable } from 'rxjs';

import { ShareKind } from './share-target';

/** The reads of the share dialog: board and folder variants of the contract behind one call. */
@Service()
export class ShareReads {
  private readonly sharingApi = inject(SharingService);
  private readonly usersApi = inject(UsersService);

  members(kind: ShareKind, id: string): Observable<MemberList> {
    return kind === 'board'
      ? this.sharingApi.listBoardMembers({ boardId: id })
      : this.sharingApi.listFolderMembers({ folderId: id });
  }

  links(kind: ShareKind, id: string): Observable<ShareLinkList> {
    return kind === 'board'
      ? this.sharingApi.listBoardShareLinks({ boardId: id })
      : this.sharingApi.listFolderShareLinks({ folderId: id });
  }

  /** Users whose username or display name starts with `q` (at least 2 characters). */
  searchUsers(q: string): Observable<UserSummaryList> {
    return this.usersApi.searchUsers({ q });
  }
}
