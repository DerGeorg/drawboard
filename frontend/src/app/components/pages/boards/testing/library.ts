import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Folder } from '@apps/drawboard-api';

import { settle } from '../../../../test/http-testing';

/**
 * Answers the pending GET /api/folders without `parentId` (the user's own folders, shared by
 * the sidebar tree and the library page).
 */
export async function flushFolders(folders: Folder[] = []): Promise<void> {
  TestBed.inject(HttpTestingController)
    .expectOne(
      (req) => req.method === 'GET' && req.url === '/api/folders' && !req.params.has('parentId'),
      'list own folders',
    )
    .flush({ items: folders });
  await settle();
}
