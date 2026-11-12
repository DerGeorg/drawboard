import { Service, signal } from '@angular/core';

import type { PeerPresence } from '../../../../../board-engine/presence';
import type { ProviderState } from '../../../../../board-engine/collab/provider';
import { BoardDoc } from '../../../../../board-engine/model/board-doc';
import { BoardCollab } from '../board-collab';
import { BoardFiles } from '../board-files';
import { BoardPlugins } from '../board-plugins';
import { BoardUploads } from '../board-uploads';
import { BoardFollow } from '../board-follow';
import { BoardPoker } from '../poker/board-poker';

/** Stands in for the live connection of a board page: no ticket request, no WebSocket. */
@Service({ autoProvided: false })
export class FakeBoardCollab {
  readonly doc = signal(new BoardDoc());
  readonly state = signal<ProviderState | undefined>(undefined);
  readonly peers = signal<PeerPresence[]>([]);
  readonly clientId = signal<number | undefined>(1);
  readonly setLocalFields = vi.fn<(fields: Record<string, unknown>) => void>();
  /** Connects at once: the page shows "Live". */
  readonly connect = vi.fn<(boardId: string) => void>(() =>
    this.state.set({
      status: 'synced',
      role: 'EDITOR',
      error: undefined,
      closeCode: undefined,
      reloadRequired: false,
    }),
  );
  readonly bind = vi.fn();
}

/**
 * Provider override for BoardPage: `TestBed.overrideComponent(BoardPage, fakeBoardCollab)`. The
 * page's other services stay real (file metadata and uploads through HttpTestingController).
 */
export const fakeBoardCollab = {
  set: {
    providers: [
      { provide: BoardCollab, useClass: FakeBoardCollab },
      BoardFiles,
      BoardUploads,
      BoardPlugins,
      BoardPoker,
      BoardFollow,
    ],
  },
};
