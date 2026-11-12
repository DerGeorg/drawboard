import { TestBed } from '@angular/core/testing';
import { CollabService } from '@apps/drawboard-api';
import { of } from 'rxjs';
import * as Y from 'yjs';

import type { SocketLike } from '../../../../board-engine/collab/provider';
import { Toasts } from '../../../services/toasts';
import { BoardCollab } from './board-collab';

/** A socket that never opens: enough to see what BoardCollab hands the provider. */
class SilentSocket implements SocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: Uint8Array[] = [];
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
}

describe('BoardCollab', () => {
  const ticket = {
    ticket: 'a'.repeat(43),
    expiresAt: '2026-11-09T12:00:30Z',
    url: '/api/boards/b1/collab',
    protocol: 'drawboard.v1',
  };
  let api: {
    createCollabTicket: ReturnType<typeof vi.fn>;
    uploadBoardSnapshot: ReturnType<typeof vi.fn>;
  };
  let sockets: { url: string; protocols: string[]; socket: SilentSocket }[];
  let collab: BoardCollab;

  beforeEach(() => {
    api = {
      createCollabTicket: vi.fn(() => of(ticket)),
      uploadBoardSnapshot: vi.fn(() => of(undefined)),
    };
    sockets = [];
    TestBed.configureTestingModule({
      providers: [BoardCollab, { provide: CollabService, useValue: api }],
    });
    collab = TestBed.inject(BoardCollab);
    collab.createSocket = (url, protocols) => {
      const socket = new SilentSocket();
      sockets.push({ url, protocols, socket });
      return socket;
    };
  });

  describe('connect', () => {
    it('when connecting then a ticket for the board is fetched and the socket opened with it as subprotocol', async () => {
      collab.connect('b1');
      collab.connect('b1');
      await vi.waitFor(() => expect(sockets.length, 'one socket').toBe(1));

      expect(api.createCollabTicket.mock.calls, 'one ticket for the board').toEqual([
        [{ boardId: 'b1' }],
      ]);
      expect(sockets[0]?.url, 'socket url').toMatch(
        /^ws:\/\/localhost(:\d+)?\/api\/boards\/b1\/collab$/,
      );
      expect(sockets[0]?.protocols, 'subprotocols').toEqual([
        'drawboard.v1',
        `ticket.${ticket.ticket}`,
      ]);
      expect(collab.state()?.status, 'state').toBe('connecting');
    });

    it('when the document is not yet synced then it carries no schema version', () => {
      expect(
        collab.doc().doc.getMap('meta').get('schemaVersion'),
        'not initialised before sync',
      ).toBeUndefined();
      expect(collab.doc().doc, 'a Y.Doc').toBeInstanceOf(Y.Doc);
    });

    it('when the page goes away then the socket is closed', async () => {
      collab.connect('b1');
      await vi.waitFor(() => expect(sockets.length, 'socket').toBe(1));

      TestBed.resetTestingModule();

      expect(sockets[0]?.socket.readyState, 'closed').toBe(3);
    });
  });

  describe('peers', () => {
    it('when the provider reports participants then they are exposed as a signal', () => {
      collab.connect('b1');
      const peer = {
        clientId: 7,
        name: 'Bob',
        color: '#2563eb',
        guest: false,
        role: 'EDITOR' as const,
        cursor: null,
        selection: [],
        userId: 'user-1',
        viewport: null,
        following: null,
        summon: null,
      };

      collab['provider']?.peersChanged.emit([peer]);

      expect(collab.peers(), 'peers').toEqual([peer]);
    });
  });

  describe('document replaced (4410)', () => {
    it('when the server closes with 4410 then a fresh document, ticket and socket replace the old ones and a toast tells', async () => {
      collab.connect('b1');
      await vi.waitFor(() => expect(sockets.length, 'first socket').toBe(1));
      const oldDoc = collab.doc();
      oldDoc.doc.getMap('meta').set('marker', 'old content');

      sockets[0]?.socket.onclose?.({ code: 4410 } as never);
      await vi.waitFor(() => expect(sockets.length, 'socket after the restore').toBe(2));

      expect(collab.doc(), 'document instance').not.toBe(oldDoc);
      expect(
        collab.doc().doc.getMap('meta').get('marker'),
        'old state is not merged back',
      ).toBeUndefined();
      expect(api.createCollabTicket.mock.calls.length, 'tickets').toBe(2);
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.message),
        'toasts',
      ).toEqual(['The board was restored to an earlier version.']);
      expect(collab.peers(), 'peers').toEqual([]);
    });

    it('when the page goes away after a restore then the new socket is closed', async () => {
      collab.connect('b1');
      await vi.waitFor(() => expect(sockets.length, 'first socket').toBe(1));
      sockets[0]?.socket.onclose?.({ code: 4410 } as never);
      await vi.waitFor(() => expect(sockets.length, 'second socket').toBe(2));

      TestBed.resetTestingModule();

      expect(sockets[1]?.socket.readyState, 'closed').toBe(3);
    });
  });

  describe('waiting for the server', () => {
    it('when the state is not synced yet then whenSynced rejects after the timeout', async () => {
      collab.connect('b1');

      await expect(collab.whenSynced(120), 'rejection').rejects.toThrow('did not answer in time');
    });

    it('when the server denies the board then whenSynced rejects at once', async () => {
      collab.connect('b1');
      await vi.waitFor(() => expect(sockets.length, 'socket').toBe(1));
      sockets[0]?.socket.onclose?.({ code: 4403 } as never);

      await expect(collab.whenSynced(1000), 'rejection').rejects.toThrow('cannot be edited');
    });

    it('when nothing is pending then whenFlushed resolves; before connecting too', async () => {
      await expect(collab.whenFlushed(100), 'before connecting').resolves.toBeUndefined();
      collab.connect('b1');

      await expect(collab.whenFlushed(100), 'connected').resolves.toBeUndefined();
    });
  });
});
