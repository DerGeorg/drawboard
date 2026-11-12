import { DestroyRef, Service, inject, signal } from '@angular/core';
import { CollabService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';
import { Awareness } from 'y-protocols/awareness';

import type { BoardEngine } from '../../../../board-engine/engine';
import type { PeerPresence } from '../../../../board-engine/presence';
import { bindPresence } from '../../../../board-engine/collab/presence-binding';
import {
  DrawboardProvider,
  type ProviderOptions,
  type ProviderState,
} from '../../../../board-engine/collab/provider';
import { BoardDoc } from '../../../../board-engine/model/board-doc';
import { Toasts } from '../../../services/toasts';

/** How the provider opens its socket; tests replace it with a fake (see board-page.spec). */
export type CollabSocketFactory = ProviderOptions['createSocket'];

/**
 * The live connection of ONE open board (provided by BoardPage, not app-wide): the board's
 * Y.Doc, the collaboration provider (api/docs/collab-protocol.md) and the presence binding to
 * the engine. Tickets and snapshots go through the generated CollabService, so the bearer token,
 * error toasts and trace headers come from the usual interceptors; the WebSocket itself carries
 * only the one-time ticket.
 */
@Service({ autoProvided: false })
export class BoardCollab {
  private readonly collabApi = inject(CollabService);

  private readonly toasts = inject(Toasts);

  /**
   * The drawing. Initialised (schema version) only after the first sync with the server. A
   * signal because an owner restoring a version replaces it with a fresh document (4410).
   */
  readonly doc = signal(new BoardDoc(undefined, false));
  /** Connection state for the top bar; undefined until `connect` was called. */
  readonly state = signal<ProviderState | undefined>(undefined);
  /** The other participants present right now (name and colour come from the server). */
  readonly peers = signal<PeerPresence[]>([]);
  /** Our Yjs client id (others name us by it); changes when the document is replaced. */
  readonly clientId = signal<number | undefined>(undefined);

  /** Replaced in tests; the default is the browser WebSocket. */
  createSocket: CollabSocketFactory = undefined;

  private provider: DrawboardProvider | undefined;
  private unbindPresence: (() => void) | undefined;
  private engine: BoardEngine | undefined;
  private boardId: string | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  /** Opens the connection to `boardId`; a second call is ignored. */
  connect(boardId: string): void {
    if (this.provider) {
      return;
    }
    this.boardId = boardId;
    this.startProvider(boardId, this.doc());
  }

  private startProvider(boardId: string, board: BoardDoc): void {
    const provider = new DrawboardProvider(board.doc, new Awareness(board.doc), {
      getTicket: () => firstValueFrom(this.collabApi.createCollabTicket({ boardId })),
      uploadSnapshot: async (upToSeq, bytes) => {
        // a Blob part: the browser sends it with a filename, so the backend treats it as a file
        const snapshot = new Blob([bytes as Uint8Array<ArrayBuffer>], {
          type: 'application/octet-stream',
        });
        await firstValueFrom(this.collabApi.uploadBoardSnapshot({ boardId, upToSeq, snapshot }));
      },
      createSocket: this.createSocket,
    });
    let initialized = false;
    provider.statusChanged.on((s) => {
      this.state.set({ ...s });
      if (!initialized && (s.status === 'synced' || s.status === 'readonly')) {
        initialized = true;
        if (s.status === 'synced') {
          board.initialize();
        }
      }
    });
    provider.peersChanged.on((peers) => this.peers.set(peers));
    provider.documentReplaced.on(() => this.replaceDocument());
    this.provider = provider;
    this.clientId.set(provider.clientId);
    this.state.set({ ...provider.state });
    provider.connect();
    this.bind(this.engine);
  }

  /**
   * An owner restored a version (close code 4410): throw away the local document and its
   * pending queue - merging them back would resurrect the replaced content - and join again with
   * a fresh document, ticket and provider. The canvas builds a new engine for the new document.
   */
  private replaceDocument(): void {
    const old = this.doc();
    this.unbindPresence?.();
    this.unbindPresence = undefined;
    this.engine = undefined; // the old engine belongs to the old document
    this.provider?.destroy();
    this.provider?.awareness.destroy();
    this.provider = undefined;
    this.peers.set([]);
    const fresh = new BoardDoc(undefined, false);
    this.doc.set(fresh);
    old.destroy();
    this.toasts.success('The board was restored to an earlier version.');
    this.startProvider(this.boardId as string, fresh);
  }

  /** Resolves once the server sent the whole document (status synced); rejects on denial or timeout. */
  whenSynced(timeoutMs = 15_000): Promise<void> {
    return this.waitFor(() => {
      const status = this.state()?.status;
      if (status === 'denied' || status === 'full') {
        throw new Error('The board cannot be edited.');
      }
      return status === 'synced';
    }, timeoutMs);
  }

  /** Resolves once the server acknowledged every local change (nothing is pending any more). */
  whenFlushed(timeoutMs = 30_000): Promise<void> {
    return this.waitFor(() => (this.provider?.pendingCount ?? 0) === 0, timeoutMs);
  }

  private waitFor(done: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = (): void => {
        try {
          if (done()) {
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            reject(new Error('The board did not answer in time.'));
          } else {
            setTimeout(check, 50);
          }
        } catch (error) {
          reject(error as Error);
        }
      };
      check();
    });
  }

  /** Merges fields into our awareness state (following, summon); undefined removes one. */
  setLocalFields(fields: Record<string, unknown>): void {
    this.provider?.setLocalFields(fields);
  }

  /** Shows remote cursors in `engine` and sends the local one; undefined unbinds. */
  bind(engine: BoardEngine | undefined): void {
    this.engine = engine;
    this.unbindPresence?.();
    this.unbindPresence = engine && this.provider ? bindPresence(engine, this.provider) : undefined;
  }

  private destroy(): void {
    this.unbindPresence?.();
    this.provider?.destroy();
    this.provider?.awareness.destroy();
    this.doc().destroy();
  }
}
