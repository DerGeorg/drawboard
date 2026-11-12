import { Service, inject } from '@angular/core';
import { BoardVersion, CollabService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ApiError } from '../../../util/api-error';
import { WithSpan } from '../../../util/tracing';

/** The command of the version history. Spans carry ids only. */
@Service()
export class VersionActions {
  private readonly collabApi = inject(CollabService);

  /**
   * Replaces the drawing by this version (owner only). The server then closes every collaboration
   * session of the board with 4410 - ours too: BoardCollab joins again with a fresh document.
   * True when it worked; failures are toasted by the error interceptor.
   */
  @WithSpan('VersionActions.restore', {
    attributes: (boardId: string, version: BoardVersion) => ({
      'board.id': boardId,
      'version.id': version.id,
    }),
  })
  async restore(boardId: string, version: BoardVersion): Promise<boolean> {
    try {
      await firstValueFrom(this.collabApi.restoreBoardVersion({ boardId, versionId: version.id }));
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        return false;
      }
      throw error;
    }
  }
}
