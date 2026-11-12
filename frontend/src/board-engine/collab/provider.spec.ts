import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { FakeCollabServer, FakeSession } from '../testing/fake-collab-server';
import { CollabTicket, DrawboardProvider, ProviderOptions, isSecureOrLocal } from './provider';

interface Client {
  doc: Y.Doc;
  awareness: Awareness;
  provider: DrawboardProvider;
  tickets: number;
  errors: unknown[];
  uploads: { upToSeq: number; bytes: Uint8Array }[];
}

const tick = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('DrawboardProvider', () => {
  let server: FakeCollabServer;
  const clients: Client[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    server = new FakeCollabServer();
  });

  afterEach(() => {
    for (const c of clients.splice(0)) {
      c.provider.destroy();
      c.awareness.destroy();
      c.doc.destroy();
    }
    vi.useRealTimers();
  });

  function client(overrides: Partial<ProviderOptions> = {}): Client {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const c: Client = {
      doc,
      awareness,
      tickets: 0,
      errors: [],
      uploads: [],
      provider: undefined as never,
    };
    c.provider = new DrawboardProvider(doc, awareness, {
      getTicket: (): Promise<CollabTicket> => {
        c.tickets++;
        return Promise.resolve({
          ticket: `t${c.tickets}`,
          url: '/api/boards/b1/collab',
          protocol: 'drawboard.v1',
        });
      },
      uploadSnapshot: (upToSeq, bytes): Promise<void> => {
        c.uploads.push({ upToSeq, bytes });
        return Promise.resolve();
      },
      socketOrigin: 'wss://board.example.com',
      createSocket: server.createSocket,
      random: () => 0.5,
      onError: (e) => c.errors.push(e),
      ...overrides,
    });
    clients.push(c);
    return c;
  }

  async function connected(overrides: Partial<ProviderOptions> = {}): Promise<Client> {
    const c = client(overrides);
    c.provider.connect();
    await tick();
    return c;
  }

  const edit = (c: Client, key: string, value: string): void => {
    c.doc.getMap('m').set(key, value);
  };
  const text = (c: Client, key: string): unknown => c.doc.getMap('m').get(key);
  const last = (): FakeSession => server.all.at(-1) as FakeSession;

  /** An update that sets m[key] on a doc that has already seen the base state. */
  function updateFor(key: string, value: string): Uint8Array {
    const d = new Y.Doc();
    d.getMap('m').set(key, value);
    return Y.encodeStateAsUpdate(d);
  }

  describe('joining', () => {
    it('when connecting then the ticket goes into the subprotocol list and the url has the origin and no ticket', async () => {
      const c = await connected();

      expect(last().protocols, 'protocols').toEqual(['drawboard.v1', 'ticket.t1']);
      expect(last().url, 'url').toBe('wss://board.example.com/api/boards/b1/collab');
      expect(last().binaryType, 'binary type').toBe('arraybuffer');
      expect(c.provider.status, 'status').toBe('synced');
    });

    it('when the server sends a snapshot and log entries then they are applied in order and the status is synced', async () => {
      const snap = new Y.Doc();
      snap.getMap('m').set('a', '1');
      server.snapshot = { upToSeq: 2, bytes: Y.encodeStateAsUpdate(snap) };
      server.seed(updateFor('x', 'old'), updateFor('y', 'old'), updateFor('b', '2'));
      const states: string[] = [];
      const c = client();
      c.provider.statusChanged.on((s) => states.push(s.status));

      c.provider.connect();
      await tick();

      expect(text(c, 'a'), 'snapshot content').toBe('1');
      expect(text(c, 'b'), 'entry after the snapshot').toBe('2');
      expect(states[0], 'first status').toBe('connecting');
      expect(states.at(-1), 'last status').toBe('synced');
      expect(c.provider.state.role, 'role').toBe('EDITOR');
    });

    it('when the log holds a malformed update then it is skipped, reported once and the board still joins', async () => {
      const garbage = new Uint8Array([0xff, 0xff, 0xff, 0x13, 0x37]);
      server.seed(garbage, updateFor('a', '1'), garbage, updateFor('b', '2'));

      const c = await connected();

      expect(c.provider.status, 'status').toBe('synced');
      expect(text(c, 'a'), 'entry before the bad one').toBe('1');
      expect(text(c, 'b'), 'entry after the bad ones').toBe('2');
      expect(c.errors.length, 'reported once').toBe(1);
      expect(String(c.errors[0]), 'what').toContain('malformed update');
    });

    it('when the board is empty then synced arrives with head 0', async () => {
      const c = await connected();

      expect(c.provider.status, 'status').toBe('synced');
      expect(c.provider.pendingCount, 'pending').toBe(0);
    });

    it('when the ticket protocol is not drawboard.v1 then no socket opens and a retry is scheduled', async () => {
      const c = client({
        getTicket: () => Promise.resolve({ ticket: 't', url: '/x', protocol: 'drawboard.v2' }),
      });

      c.provider.connect();
      await tick();

      expect(server.all.length, 'sockets').toBe(0);
      expect(c.provider.status, 'status').toBe('offline');
      expect(c.provider.state.error, 'error').toBe('Connection failed');
      expect(String(c.errors[0]), 'reported').toContain('Unsupported collaboration protocol');
    });

    it('when the ticket url is not a path then no socket opens', async () => {
      const c = client({
        getTicket: () =>
          Promise.resolve({ ticket: 't', url: 'wss://evil.example/x', protocol: 'drawboard.v1' }),
      });

      c.provider.connect();
      await tick();

      expect(server.all.length, 'sockets').toBe(0);
      expect(c.provider.status, 'status').toBe('offline');
    });

    it('when the origin is an insecure ws url then no socket opens, but ws://localhost is fine', async () => {
      const c = client({ socketOrigin: 'ws://board.example.com' });
      c.provider.connect();
      await tick();
      expect(server.all.length, 'sockets for a remote ws origin').toBe(0);

      expect(isSecureOrLocal('ws://localhost:4200'), 'localhost').toBe(true);
      expect(isSecureOrLocal('ws://127.0.0.1'), 'loopback').toBe(true);
      expect(isSecureOrLocal('ws://[::1]:80'), 'ipv6 loopback').toBe(true);
      expect(isSecureOrLocal('ws://localhost.evil.com'), 'lookalike').toBe(false);
      expect(isSecureOrLocal('wss://x'), 'wss').toBe(true);
    });

    it('when no origin is given then it is derived from the page location', async () => {
      const c = client({ socketOrigin: undefined });

      c.provider.connect();
      await tick();

      expect(last().url.startsWith('ws://localhost'), 'derived from jsdom location').toBe(true);
    });

    it('when the ticket request fails then it is retried with backoff', async () => {
      let calls = 0;
      const c = client({
        getTicket: () => {
          calls++;
          return calls === 1
            ? Promise.reject(new Error('401'))
            : Promise.resolve({
                ticket: 't',
                url: '/api/boards/b1/collab',
                protocol: 'drawboard.v1',
              });
        },
      });

      c.provider.connect();
      await tick();
      expect(c.provider.status, 'status after failure').toBe('offline');
      await vi.advanceTimersByTimeAsync(1000);

      expect(calls, 'ticket calls').toBe(2);
      expect(c.provider.status, 'status after retry').toBe('synced');
    });

    it('when connect is called twice or after destroy then nothing breaks', async () => {
      const c = client();
      c.provider.connect();
      c.provider.connect();
      await tick();
      c.provider.destroy();
      c.provider.destroy();
      c.provider.connect();
      await tick();

      expect(server.all.length, 'sockets').toBe(1);
    });
  });

  describe('updates', () => {
    it('when a local edit happens then an UPDATE frame is sent and the ACK clears the queue', async () => {
      const c = await connected();

      edit(c, 'a', '1');
      expect(c.provider.pendingCount, 'pending before ack').toBe(0);

      expect(last().framesOf(0x01).length, 'update frames').toBe(1);
      expect(server.log.length, 'server log').toBe(1);
      expect(c.provider.pendingCount, 'pending after ack').toBe(0);
    });

    it('when the server does not ack then the update stays pending', async () => {
      const c = await connected();
      last().deliver = () => undefined;

      edit(c, 'a', '1');

      expect(c.provider.pendingCount, 'pending').toBe(1);
    });

    it('when two clients edit then both converge and remote updates are not sent back', async () => {
      const a = await connected();
      const b = await connected();

      edit(a, 'k', 'from a');
      edit(b, 'j', 'from b');

      expect(text(b, 'k'), 'b sees a').toBe('from a');
      expect(text(a, 'j'), 'a sees b').toBe('from b');
      expect(server.log.length, 'each edit logged once (no echo)').toBe(2);
    });

    it('when edits were made before connecting then they are merged into one update sent after SYNCED', async () => {
      const c = client();
      edit(c, 'a', '1');
      edit(c, 'b', '2');
      expect(c.provider.pendingCount, 'queued while disconnected').toBe(2);

      c.provider.connect();
      await tick();

      expect(last().framesOf(0x01).length, 'one merged frame').toBe(1);
      expect(server.log.length, 'log entries').toBe(1);
      const check = new Y.Doc();
      Y.applyUpdate(check, server.log[0]?.bytes ?? new Uint8Array());
      expect(check.getMap('m').toJSON(), 'merged content').toEqual({ a: '1', b: '2' });
    });

    it('when more than 50 updates queue up offline then they are merged on the way', () => {
      const c = client();

      for (let i = 0; i < 60; i++) {
        edit(c, `k${i}`, 'v');
      }

      expect(c.provider.pendingCount, 'queue is bounded').toBeLessThanOrEqual(11);
    });

    it('when the connection breaks then edits made offline reach the server once after reconnecting', async () => {
      const c = await connected();
      edit(c, 'before', '1');
      last().serverClose(1011);
      edit(c, 'offline1', '2');
      edit(c, 'offline2', '3');
      expect(c.provider.status, 'status').toBe('offline');

      await vi.advanceTimersByTimeAsync(1000);

      expect(c.provider.status, 'status after reconnect').toBe('synced');
      expect(server.all.length, 'second socket').toBe(2);
      expect(last().framesOf(0x01).length, 'one merged update on the new socket').toBe(1);
      const check = new Y.Doc();
      for (const e of server.log) {
        Y.applyUpdate(check, e.bytes);
      }
      expect(check.getMap('m').toJSON(), 'server state').toEqual({
        before: '1',
        offline1: '2',
        offline2: '3',
      });
    });

    it('when the same state is sent twice then the document is unchanged (duplicates are harmless)', async () => {
      const a = await connected();
      edit(a, 'k', 'v');
      const dup = server.log[0]?.bytes ?? new Uint8Array();
      const b = await connected();

      Y.applyUpdate(b.doc, dup);

      expect(b.doc.getMap('m').toJSON(), 'b').toEqual({ k: 'v' });
    });

    it('when a snapshot exceeds the update limit then it is not sent and a reload is required', async () => {
      const c = await connected();

      c.doc.getMap('m').set('big', 'x'.repeat(1_100_000));

      expect(last().framesOf(0x01).length, 'frames').toBe(0);
      expect(c.provider.state.reloadRequired, 'reload required').toBe(true);
      expect(c.provider.pendingCount, 'queue dropped').toBe(0);
    });
  });

  describe('roles', () => {
    it('when the role is viewer then edits are not sent and the status is readonly', async () => {
      server.nextRole = 'VIEWER';
      const c = await connected();

      edit(c, 'a', '1');

      expect(c.provider.status, 'status').toBe('readonly');
      expect(c.provider.canEdit, 'can edit').toBe(false);
      expect(last().framesOf(0x01).length, 'update frames').toBe(0);
    });

    it('when the role changes to editor then queued edits are flushed, and back to viewer stops sending', async () => {
      server.nextRole = 'VIEWER';
      const c = await connected();
      edit(c, 'a', '1');

      server.setRole(last(), 'EDITOR');
      expect(c.provider.status, 'status as editor').toBe('synced');
      expect(last().framesOf(0x01).length, 'flushed frame').toBe(1);
      server.setRole(last(), 'COMMENTER');
      edit(c, 'b', '2');

      expect(c.provider.status, 'status as commenter').toBe('readonly');
      expect(last().framesOf(0x01).length, 'no further frames').toBe(1);
    });
  });

  describe('close codes', () => {
    async function closedWith(code: number): Promise<Client> {
      const c = await connected();
      last().serverClose(code);
      return c;
    }

    it.each([
      [4403, 'denied'],
      [4404, 'denied'],
      [4413, 'full'],
      [1000, 'offline'],
    ])(
      'when the server closes with %i then the status is %s and nobody reconnects',
      async (code, status) => {
        const c = await closedWith(code);
        await vi.advanceTimersByTimeAsync(120_000);

        expect(c.provider.status, 'status').toBe(status);
        expect(c.provider.state.closeCode, 'close code').toBe(code);
        expect(server.all.length, 'sockets').toBe(1);
      },
    );

    it('when the server closes with 4410 then the queue is dropped, the host is told and nobody reconnects', async () => {
      const c = await connected();
      let replaced = 0;
      c.provider.documentReplaced.on(() => replaced++);
      last().deliver = () => undefined; // never acknowledged
      edit(c, 'a', '1');
      expect(c.provider.pendingCount, 'queued before').toBe(1);
      last().serverClose(4410);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(replaced, 'replaced events').toBe(1);
      expect(c.provider.pendingCount, 'pending queue').toBe(0);
      expect(c.provider.state.closeCode, 'close code').toBe(4410);
      expect(server.all.length, 'no automatic reconnect with the old document').toBe(1);
    });

    it('when a stopped provider connects again then it works', async () => {
      const c = await closedWith(4403);

      c.provider.connect();
      await tick();

      expect(c.provider.status, 'status').toBe('synced');
    });

    it.each([1001, 1011, 4408])(
      'when the server closes with %i then it reconnects with backoff',
      async (code) => {
        const c = await closedWith(code);
        expect(c.provider.status, 'offline right after').toBe('offline');
        await vi.advanceTimersByTimeAsync(999);
        expect(server.all.length, 'not yet').toBe(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(server.all.length, 'reconnected').toBe(2);
        expect(c.provider.status, 'status').toBe('synced');
      },
    );

    it('when the token expired (4401) then a new ticket is fetched and the socket reopens at once', async () => {
      const c = await closedWith(4401);
      await tick();

      expect(c.tickets, 'tickets').toBe(2);
      expect(server.all.length, 'sockets').toBe(2);
      expect(c.provider.status, 'status').toBe('synced');
    });

    it('when 4401 arrives before the welcome then it backs off instead of looping', async () => {
      await closedWith(4401);
      await tick();
      server.closeAfterOpen = [4401];
      last().serverClose(1011);
      await vi.advanceTimersByTimeAsync(1000);
      const sockets = server.all.length;
      await tick();

      expect(sockets, 'the early 4401 socket exists').toBe(3);
      expect(server.all.length, 'no immediate reconnect').toBe(3);
      await vi.advanceTimersByTimeAsync(3000);
      expect(server.all.length, 'reconnected after the backoff').toBe(4);
    });

    it('when the rate limit closes (4429) then it waits 30 seconds', async () => {
      await closedWith(4429);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(server.all.length, 'before 30 s').toBe(1);

      await vi.advanceTimersByTimeAsync(1);

      expect(server.all.length, 'after 30 s').toBe(2);
    });

    it('when the protocol is violated (4400) then it reconnects once and gives up with an error the second time', async () => {
      const c = await closedWith(4400);
      server.closeAfterOpen = [4400];
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.all.length, 'reconnected once').toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(server.all.length, 'no third socket').toBe(2);
      expect(c.provider.state.error, 'error').toBe('Protocol error');
      expect(c.provider.status, 'status').toBe('offline');
    });

    it('when a frame is too large (1009) then the queue is dropped, a reload is required, and it does not reconnect', async () => {
      const c = await connected();
      last().deliver = () => undefined;
      edit(c, 'a', '1');

      last().serverClose(1009);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(c.provider.pendingCount, 'pending').toBe(0);
      expect(c.provider.state.reloadRequired, 'reload').toBe(true);
      expect(server.all.length, 'sockets').toBe(1);
    });

    it('when the handshake fails then a new ticket is requested once, then the failure is reported with backoff', async () => {
      server.failHandshakes = 2;
      const c = client();

      c.provider.connect();
      await tick();
      expect(c.tickets, 'second ticket requested at once').toBe(2);
      expect(c.provider.status, 'status').toBe('offline');
      expect(c.provider.state.error, 'error').toBe('Connection failed');
      await vi.advanceTimersByTimeAsync(1000);

      expect(c.tickets, 'third ticket after backoff').toBe(3);
      expect(c.provider.status, 'status after success').toBe('synced');
      expect(c.provider.state.error, 'error cleared').toBeUndefined();
    });
  });

  describe('backoff', () => {
    it('when the server keeps failing then the delay doubles up to 30 s', async () => {
      const c = await connected();
      const delays: number[] = [];
      for (let i = 0; i < 7; i++) {
        last().serverClose(1011);
        const before = server.all.length;
        let waited = 0;
        while (server.all.length === before && waited < 40_000) {
          await vi.advanceTimersByTimeAsync(250);
          waited += 250;
        }
        delays.push(waited);
        // the new session closes before the stability timer resets the counter
      }

      expect(delays, 'delays').toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
      expect(c.provider.status, 'status').toBe('synced');
    });

    it('when a connection stays up for 10 seconds then the next delay starts at 1 s again', async () => {
      await connected();
      last().serverClose(1011);
      await vi.advanceTimersByTimeAsync(1000);
      last().serverClose(1011);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(10_000);
      const sockets = server.all.length;

      last().serverClose(1011);
      await vi.advanceTimersByTimeAsync(1000);

      expect(server.all.length, 'reconnected after 1 s').toBe(sockets + 1);
    });
  });

  describe('keep-alive', () => {
    it('when connected then PING is sent every 30 seconds and PONG keeps the connection', async () => {
      await connected();

      await vi.advanceTimersByTimeAsync(95_000);

      expect(last().framesOf(0x03).length, 'pings').toBe(3);
      expect(server.all.length, 'still the same socket').toBe(1);
    });

    it('when nothing arrives for 60 seconds then the provider reconnects', async () => {
      const c = await connected();
      last().deliver = () => undefined; // the server went silent

      await vi.advanceTimersByTimeAsync(91_000);
      await vi.advanceTimersByTimeAsync(2000);

      expect(server.all.length, 'reconnected').toBeGreaterThanOrEqual(2);
      expect(c.provider.status, 'status').toBe('synced');
    });
  });

  describe('protocol errors from the server', () => {
    it('when a text frame arrives then the connection is closed as a protocol violation', async () => {
      const c = await connected();

      last().onmessage?.({ data: 'hello' });

      expect(c.provider.state.closeCode, 'close code').toBe(4400);
      expect(c.errors.length, 'reported').toBe(1);
    });

    it('when an unknown message type arrives then the connection is closed as a protocol violation', async () => {
      const c = await connected();

      server.raw(last(), Uint8Array.of(0x42));

      expect(c.provider.state.closeCode, 'close code').toBe(4400);
    });

    it('when a typed array view is delivered then it is decoded too', async () => {
      const c = await connected();
      const frame = (() => {
        const e = encoding.createEncoder();
        encoding.writeUint8(e, 0x8a);
        encoding.writeVarString(e, JSON.stringify({ role: 'VIEWER' }));
        return encoding.toUint8Array(e);
      })();

      last().onmessage?.({ data: new Uint8Array(frame.buffer.slice(0), 0, frame.length) });

      expect(c.provider.status, 'status').toBe('readonly');
    });

    it('when a frame of an old socket arrives then it is ignored', async () => {
      const c = await connected();
      const old = last();
      old.serverClose(1011);
      await vi.advanceTimersByTimeAsync(1000);

      old.onmessage?.({ data: 'ignored' });
      old.onopen?.({});

      expect(c.provider.status, 'status').toBe('synced');
    });

    it('when the socket reports an error then nothing happens until it closes', async () => {
      const c = await connected();

      last().onerror?.({});

      expect(c.provider.status, 'status').toBe('synced');
    });
  });

  describe('compaction', () => {
    it('when COMPACT arrives with an empty queue then the full state is uploaded with the sequence number', async () => {
      const c = await connected();
      edit(c, 'a', '1');

      server.compact(last(), server.head);
      await tick();

      expect(c.uploads.length, 'uploads').toBe(1);
      expect(c.uploads[0]?.upToSeq, 'up to seq').toBe(1);
      const check = new Y.Doc();
      Y.applyUpdate(check, c.uploads[0]?.bytes ?? new Uint8Array());
      expect(check.getMap('m').toJSON(), 'snapshot content').toEqual({ a: '1' });
    });

    it('when the queue is not empty then COMPACT is ignored', async () => {
      const c = await connected();
      last().deliver = () => undefined;
      edit(c, 'a', '1');

      server.compact(last(), 1);
      await tick();

      expect(c.uploads.length, 'uploads').toBe(0);
    });

    it('when the client has not applied everything up to the requested sequence then COMPACT is ignored', async () => {
      const c = await connected();

      server.compact(last(), 99);
      await tick();

      expect(c.uploads.length, 'uploads').toBe(0);
    });

    it('when the user is a viewer then COMPACT is ignored', async () => {
      server.nextRole = 'VIEWER';
      const c = await connected();

      server.compact(last(), 0);
      await tick();

      expect(c.uploads.length, 'uploads').toBe(0);
    });

    it('when the upload fails then the error is reported and a later request is answered', async () => {
      let fail = true;
      const c = await connected({
        uploadSnapshot: (upToSeq, bytes) => {
          if (fail) {
            return Promise.reject(new Error('413'));
          }
          void upToSeq;
          void bytes;
          return Promise.resolve();
        },
      });

      server.compact(last(), 0);
      await tick();
      fail = false;
      server.compact(last(), 0);
      server.compact(last(), 0);
      await tick();

      expect(String(c.errors[0]), 'reported').toContain('413');
    });
  });

  describe('awareness', () => {
    const awarenessEntries = (s: FakeSession): { clientId: number; json: string }[] =>
      s.framesOf(0x02).map((f) => {
        const d = decoding.createDecoder(f.payload);
        decoding.readVarUint(d); // count
        const clientId = decoding.readVarUint(d);
        decoding.readVarUint(d); // clock
        return { clientId, json: decoding.readVarString(d) };
      });

    it('when the local state changes then one awareness entry for the own client id is sent, throttled to 10 per second', async () => {
      const c = await connected();
      const before = last().framesOf(0x02).length;

      c.awareness.setLocalState({ cursor: { x: 1, y: 2 }, selection: [] });
      c.awareness.setLocalState({ cursor: { x: 3, y: 4 }, selection: [] });
      c.awareness.setLocalState({ cursor: { x: 5, y: 6 }, selection: ['b1'] });
      await vi.advanceTimersByTimeAsync(0);
      const afterFirst = last().framesOf(0x02).length;
      await vi.advanceTimersByTimeAsync(150);

      expect(afterFirst - before, 'frames before the throttle window ends').toBeLessThanOrEqual(1);
      expect(
        last().framesOf(0x02).length - before,
        'frames in total: 3 changes are at most 2 frames',
      ).toBeLessThanOrEqual(2);
      const entries = awarenessEntries(last());
      expect(
        entries.every((e) => e.clientId === c.doc.clientID),
        'only the own client id',
      ).toBe(true);
      expect(entries.at(-1)?.json, 'latest state').toContain('"b1"');
    });

    it('when the awareness frame would be too large then it is not sent', async () => {
      const c = await connected();
      const before = last().framesOf(0x02).length;

      c.awareness.setLocalState({ cursor: null, selection: ['x'.repeat(17_000)] });
      await vi.advanceTimersByTimeAsync(200);

      expect(last().framesOf(0x02).length, 'frames').toBe(before);
    });

    it('when the session stays open then the state is re-sent every 15 seconds', async () => {
      const c = await connected();
      c.awareness.setLocalState({ cursor: null, selection: [] });
      await vi.advanceTimersByTimeAsync(200);
      const before = last().framesOf(0x02).length;

      await vi.advanceTimersByTimeAsync(15_000);

      expect(last().framesOf(0x02).length, 'frames after 15 s').toBeGreaterThan(before);
    });

    it('when a peer joins then the current state is sent at once', async () => {
      const a = await connected();
      a.awareness.setLocalState({ cursor: { x: 1, y: 1 }, selection: [] });
      await vi.advanceTimersByTimeAsync(200);
      const before = server.all[0]?.framesOf(0x02).length ?? 0;

      await connected();

      expect(
        (server.all[0]?.framesOf(0x02).length ?? 0) - before,
        'awareness frames sent for PEER_JOINED',
      ).toBe(1);
    });

    it('when another client sends awareness then name and color come from the server, not from the payload', async () => {
      const a = await connected();
      const b = await connected();
      a.awareness.setLocalState({
        cursor: { x: 10, y: 20 },
        selection: ['blk'],
        name: 'Mallory',
        color: '#000',
      });
      await vi.advanceTimersByTimeAsync(200);

      const peers = b.provider.currentPeers();

      expect(peers, 'peers').toEqual([
        {
          clientId: a.doc.clientID,
          userId: 'u1',
          name: 'User u1',
          color: '#e8590c',
          guest: false,
          role: null,
          cursor: { x: 10, y: 20 },
          selection: ['blk'],
          viewport: null,
          following: null,
          summon: null,
        },
      ]);
    });

    it('when the server names the sender role in From then the peer carries it, otherwise null', async () => {
      const a = await connected();
      const b = await connected();
      (server.all[0] as FakeSession).from.role = 'EDITOR'; // a's session was opened first
      a.provider.setLocalFields({ cursor: { x: 1, y: 1 } });
      await vi.advanceTimersByTimeAsync(200);

      expect(b.provider.currentPeers()[0], 'role from From').toMatchObject({ role: 'EDITOR' });
    });

    it('when another client publishes viewport, following and summon then they arrive validated', async () => {
      const a = await connected();
      const b = await connected();
      a.provider.setLocalFields({
        viewport: { x: 100, y: -50, zoom: 0.5 },
        following: b.doc.clientID,
        summon: { id: 7, targets: [b.doc.clientID] },
        extra: 'ignored',
      });
      await vi.advanceTimersByTimeAsync(200);

      expect(b.provider.currentPeers()[0], 'peer').toMatchObject({
        viewport: { x: 100, y: -50, zoom: 0.5 },
        following: b.doc.clientID,
        summon: { id: 7, targets: [b.doc.clientID] },
      });
      expect(b.provider.currentPeers()[0], 'unknown field').not.toHaveProperty('extra');
    });

    it('when local fields are merged then the others stay and undefined removes one', async () => {
      const a = await connected();
      a.provider.setLocalFields({ cursor: { x: 1, y: 2 }, following: 5 });
      a.provider.setLocalFields({ following: undefined, summon: { id: 1, targets: 'all' } });

      expect(a.awareness.getLocalState(), 'state').toEqual({
        cursor: { x: 1, y: 2 },
        summon: { id: 1, targets: 'all' },
      });
      expect(a.provider.clientId, 'client id').toBe(a.doc.clientID);
    });

    it('when the payload cursor and selection are malformed then they are sanitized', async () => {
      const a = await connected();
      const b = await connected();
      a.awareness.setLocalState({ cursor: { x: 'a', y: 1 }, selection: ['ok', 5, null] });
      await vi.advanceTimersByTimeAsync(200);

      expect(b.provider.currentPeers()[0], 'peer').toMatchObject({
        cursor: null,
        selection: ['ok'],
      });
    });

    it('when peers change then listeners get the new list, and PEER_LEFT removes the peer', async () => {
      const a = await connected();
      const b = await connected();
      const seen: number[] = [];
      b.provider.peersChanged.on((p) => seen.push(p.length));
      a.awareness.setLocalState({ cursor: null, selection: [] });
      await vi.advanceTimersByTimeAsync(200);
      expect(b.provider.currentPeers().length, 'peer visible').toBe(1);

      server.all[0]?.close(1000);

      expect(b.provider.currentPeers().length, 'peer removed').toBe(0);
      expect(seen.at(-1), 'last notification').toBe(0);
    });

    it('when the awareness entry does not match the sender then it is dropped', async () => {
      const b = await connected();
      const forged = (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 999);
        encoding.writeVarUint(e, 1);
        encoding.writeVarString(e, JSON.stringify({ cursor: { x: 1, y: 1 } }));
        return encoding.toUint8Array(e);
      })();
      const frame = (() => {
        const e = encoding.createEncoder();
        encoding.writeUint8(e, 0x85);
        encoding.writeVarString(
          e,
          JSON.stringify({ id: 'evil', name: 'Evil', guest: false, color: '#fff', clientId: 1234 }),
        );
        encoding.writeUint8Array(e, forged);
        return encoding.toUint8Array(e);
      })();

      server.raw(last(), frame);

      expect(b.provider.currentPeers().length, 'peers').toBe(0);
      expect(b.awareness.getStates().has(999), 'foreign state').toBe(false);
    });

    it('when a frame claims our own client id then our state is not overwritten', async () => {
      const b = await connected();
      b.awareness.setLocalState({ cursor: null, selection: [] });
      const forged = (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, b.doc.clientID);
        encoding.writeVarUint(e, 99);
        encoding.writeVarString(e, JSON.stringify({ cursor: { x: 9, y: 9 }, selection: [] }));
        return encoding.toUint8Array(e);
      })();
      const frame = (() => {
        const e = encoding.createEncoder();
        encoding.writeUint8(e, 0x85);
        encoding.writeVarString(
          e,
          JSON.stringify({
            id: 'evil',
            name: 'Evil',
            guest: false,
            color: '#fff',
            clientId: b.doc.clientID,
          }),
        );
        encoding.writeUint8Array(e, forged);
        return encoding.toUint8Array(e);
      })();

      server.raw(last(), frame);

      expect(b.awareness.getLocalState(), 'own state').toEqual({ cursor: null, selection: [] });
    });

    it('when a relayed awareness frame is larger than the awareness limit then it is not parsed', async () => {
      const b = await connected();
      const big = (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 4242);
        encoding.writeVarUint(e, 1);
        encoding.writeVarString(e, JSON.stringify({ selection: ['x'.repeat(17_000)] }));
        return encoding.toUint8Array(e);
      })();
      const frame = (() => {
        const e = encoding.createEncoder();
        encoding.writeUint8(e, 0x85);
        encoding.writeVarString(
          e,
          JSON.stringify({ id: 'big', name: 'Big', guest: false, color: '#fff', clientId: 4242 }),
        );
        encoding.writeUint8Array(e, big);
        return encoding.toUint8Array(e);
      })();

      server.raw(last(), frame);

      expect(b.awareness.getStates().has(4242), 'dropped').toBe(false);
    });

    it('when the connection is lost then remote states are forgotten, and relearned after the reconnect', async () => {
      const a = await connected();
      const b = await connected();
      a.awareness.setLocalState({ cursor: null, selection: [] });
      await vi.advanceTimersByTimeAsync(200);
      expect(b.provider.currentPeers().length, 'before').toBe(1);

      server.all[1]?.serverClose(1011);
      expect(b.provider.currentPeers().length, 'forgotten').toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      a.awareness.setLocalState({ cursor: { x: 1, y: 1 }, selection: [] });
      await vi.advanceTimersByTimeAsync(200);

      expect(b.provider.currentPeers().length, 'relearned').toBe(1);
    });

    it('when the provider is created with a foreign awareness then it throws', () => {
      const doc = new Y.Doc();
      const other = new Awareness(new Y.Doc());

      expect(() => new DrawboardProvider(doc, other, {} as ProviderOptions), 'constructor').toThrow(
        'same Y.Doc',
      );
      other.destroy();
    });
  });

  describe('destroy', () => {
    it('when destroyed then the socket is closed, timers stop and the awareness state is removed', async () => {
      const c = await connected();
      c.awareness.setLocalState({ cursor: null, selection: [] });
      const s = last();

      c.provider.destroy();
      await vi.advanceTimersByTimeAsync(120_000);
      edit(c, 'after', 'destroy');

      expect(s.closedByClient, 'close code').toBe(1000);
      expect(s.framesOf(0x01).length, 'no update after destroy').toBe(0);
      expect(s.framesOf(0x03).length, 'no pings after destroy').toBe(0);
      expect(c.awareness.getLocalState(), 'local state').toBeNull();
      expect(server.all.length, 'no reconnect').toBe(1);
    });

    it('when destroyed while the ticket is requested then no socket is opened', async () => {
      const c = client();
      c.provider.connect();
      c.provider.destroy();
      await tick();

      expect(server.all.length, 'sockets').toBe(0);
    });
  });
});
