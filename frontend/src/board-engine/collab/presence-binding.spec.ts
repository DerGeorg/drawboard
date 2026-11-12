import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { BoardDoc } from '../model/board-doc';
import { FakeCollabServer } from '../testing/fake-collab-server';
import { TestEngine, createTestEngine } from '../testing/helpers';
import { bindPresence } from './presence-binding';
import { DrawboardProvider } from './provider';

describe('bindPresence', () => {
  let t: TestEngine;
  let server: FakeCollabServer;
  const awarenesses: Awareness[] = [];
  const providers: DrawboardProvider[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    server = new FakeCollabServer();
  });

  afterEach(() => {
    providers.splice(0).forEach((p) => p.destroy());
    awarenesses.splice(0).forEach((a) => a.destroy());
    t?.destroy();
    vi.useRealTimers();
  });

  function provider(board: BoardDoc): DrawboardProvider {
    const awareness = new Awareness(board.doc);
    awarenesses.push(awareness);
    const p = new DrawboardProvider(board.doc, awareness, {
      getTicket: () => Promise.resolve({ ticket: 't', url: '/c', protocol: 'drawboard.v1' }),
      uploadSnapshot: () => Promise.resolve(),
      socketOrigin: 'wss://x',
      createSocket: server.createSocket,
    });
    providers.push(p);
    return p;
  }

  describe('presence', () => {
    it('when the engine moves the pointer then cursor and selection go into the awareness, and remote peers are drawn', async () => {
      t = createTestEngine({}, new BoardDoc(new Y.Doc(), false));
      const mine = provider(t.board);
      const off = bindPresence(t.engine, mine);
      const otherBoard = new BoardDoc(new Y.Doc(), false);
      const other = provider(otherBoard);
      mine.connect();
      other.connect();
      await vi.advanceTimersByTimeAsync(0);

      t.engine.pointerMove(t.at(30, 40, { buttons: 0 }));
      await vi.advanceTimersByTimeAsync(200);
      other.awareness.setLocalState({ cursor: { x: 5, y: 6 }, selection: [] });
      await vi.advanceTimersByTimeAsync(200);
      t.engine.flush();

      expect(other.currentPeers()[0]?.cursor, 'the other client sees our cursor').toEqual({
        x: 30,
        y: 40,
      });
      expect(
        t.container.querySelector('[data-peer="User u2"]'),
        'remote cursor drawn',
      ).not.toBeNull();
      off();
      otherBoard.destroy();
    });
  });

  describe('viewport', () => {
    it('when the camera moves then the rounded centre and zoom are published, at most 10 per second', async () => {
      t = createTestEngine({}, new BoardDoc(new Y.Doc(), false));
      t.engine.setViewportSize({ w: 800, h: 600 });
      const mine = provider(t.board);
      const off = bindPresence(t.engine, mine);
      const otherBoard = new BoardDoc(new Y.Doc(), false);
      const other = provider(otherBoard);
      mine.connect();
      other.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(mine.awareness.getLocalState()?.['viewport'], 'initial').toEqual({
        x: 400,
        y: 300,
        zoom: 1,
      });
      const sent = (): number => server.all[0]?.framesOf(0x02).length ?? 0;
      const before = sent();

      // 50 pan steps in 0.5 s
      for (let i = 1; i <= 50; i++) {
        t.engine.setCamera({ x: -i * 10.3, y: 0, zoom: 0.5 });
        await vi.advanceTimersByTimeAsync(10);
      }
      await vi.advanceTimersByTimeAsync(200);

      expect(sent() - before, 'throttled').toBeLessThanOrEqual(7);
      expect(other.currentPeers()[0]?.viewport, 'the other client sees our last view').toEqual({
        x: Math.round((400 + 515) / 0.5),
        y: 600,
        zoom: 0.5,
      });
      off();
      otherBoard.destroy();
    });

    it('when the camera does not move then nothing new is published', async () => {
      t = createTestEngine({}, new BoardDoc(new Y.Doc(), false));
      const mine = provider(t.board);
      const set = vi.spyOn(mine, 'setLocalFields');
      bindPresence(t.engine, mine);
      set.mockClear();

      t.engine.setCamera({ ...t.engine.camera });
      t.engine.setCamera({ ...t.engine.camera, x: t.engine.camera.x + 0.2 });

      expect(set, 'same rounded viewport').not.toHaveBeenCalled();
    });
  });

  describe('read-only', () => {
    it('when the server makes us a viewer then the engine becomes read-only, and editor again lifts it', async () => {
      t = createTestEngine({}, new BoardDoc(new Y.Doc(), false));
      server.nextRole = 'VIEWER';
      const p = provider(t.board);
      bindPresence(t.engine, p);

      p.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.engine.readOnly, 'read only as viewer').toBe(true);
      server.setRole(server.all[0] ?? (undefined as never), 'EDITOR');

      expect(t.engine.readOnly, 'writable as editor').toBe(false);
    });

    it('when the host made the engine read-only then the provider never lifts it', async () => {
      t = createTestEngine({ readOnly: true }, new BoardDoc(new Y.Doc(), false));
      const p = provider(t.board);
      bindPresence(t.engine, p);

      p.connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(t.engine.readOnly, 'read only').toBe(true);
    });
  });

  describe('initialize', () => {
    it('when a board is created for syncing then the schema version is written only on initialize', () => {
      const board = new BoardDoc(new Y.Doc(), false);
      expect(board.meta.has('schemaVersion'), 'before').toBe(false);

      board.initialize();
      board.initialize();

      expect(board.meta.get('schemaVersion'), 'after').toBe(1);
      board.destroy();
    });
  });
});
