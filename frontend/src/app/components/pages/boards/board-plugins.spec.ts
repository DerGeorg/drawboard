import { TestBed } from '@angular/core/testing';
import { EnabledPlugin, PluginCapabilityName } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../board-engine/engine';
import { BoardDoc } from '@apps/drawboard-engine';
import { Toasts } from '../../../services/toasts';
import { provideFakeAuth } from '../../../test/fake-auth';
import { SPRINT_BOARD_ID, aBoard } from '../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../test/http-testing';
import { ApiError } from '../../../util/api-error';
import {
  BoardPlugins,
  PLUGIN_FRAME_CONNECTOR,
  PLUGIN_REFRESH_MS,
  toPluginError,
} from './board-plugins';

const ID = 'org.example.counter';
const SHA = 'b'.repeat(64);
const STORAGE = `/api/boards/${SPRINT_BOARD_ID}/plugin-storage/${ID}`;

function anEnabledPlugin(capabilities: PluginCapabilityName[] = []): EnabledPlugin {
  return {
    id: ID,
    version: '1.0.0',
    assetBase: `/plugin-assets/${ID}/1.0.0/${SHA}/`,
    entry: 'index.js',
    integrity: 'sha384-x',
    blockTypes: [
      { type: `${ID}.counter`, label: 'Counter', defaultWidth: 200, defaultHeight: 100 },
    ],
    grantedCapabilities: capabilities.map((name) => ({ name })),
    userPseudonym: 'p'.repeat(43),
  };
}

describe('BoardPlugins', () => {
  let plugins: BoardPlugins;
  let board: BoardDoc;
  let engine: BoardEngine;
  let container: HTMLElement;
  let ports: MessagePort[];
  let inbox: Record<string, unknown>[];

  beforeEach(() => {
    ports = [];
    inbox = [];
    const auth = provideFakeAuth();
    auth.auth.signIn('alice', 'Alice');
    TestBed.configureTestingModule({
      providers: [
        provideHttpTesting(),
        auth.providers,
        BoardPlugins,
        {
          provide: PLUGIN_FRAME_CONNECTOR,
          useValue: (_iframe: HTMLIFrameElement, port: MessagePort) => {
            port.onmessage = (e: MessageEvent) => inbox.push(e.data as Record<string, unknown>);
            ports.push(port);
          },
        },
      ],
    });
    plugins = TestBed.inject(BoardPlugins);
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
  });

  afterEach(() => {
    TestBed.resetTestingModule(); // destroys the service: frames and ports go
    ports.forEach((p) => p.close());
    engine.destroy();
    board.destroy();
    container.remove();
    vi.useRealTimers();
  });

  async function attach(list: EnabledPlugin[]): Promise<void> {
    plugins.attach(engine, aBoard({ role: 'EDITOR' }));
    await settle();
    expectRequest('GET', '/api/plugins', 'enabled plugins').flush({ items: list });
    await Promise.resolve();
  }

  /** A running frame of the counter plugin on a new block. */
  async function frame(capabilities: PluginCapabilityName[]): Promise<MessagePort> {
    await attach([anEnabledPlugin(capabilities)]);
    board.addBlock({ type: `${ID}.counter`, x: 0, y: 0, w: 200, h: 100 });
    container.querySelector('iframe')?.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(ports.length, 'connected').toBe(1));
    return ports[0] as MessagePort;
  }

  const replyTo = async (id: string): Promise<Record<string, unknown>> => {
    let found: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      found = inbox.find((m) => m['requestId'] === id);
      expect(found, `reply ${id}`).toBeDefined();
    });
    return found?.['payload'] as Record<string, unknown>;
  };

  describe('loading', () => {
    it('when attached then the enabled plugins are read and their block types offered', async () => {
      await attach([anEnabledPlugin()]);

      expect(
        plugins.blockOptions().map((o) => o.type),
        'offered',
      ).toEqual([`${ID}.counter`]);
    });

    it('when a minute passed and the plugin was disabled meanwhile then its blocks lose their frames', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      await attach([anEnabledPlugin()]);
      board.addBlock({ type: `${ID}.counter`, x: 0, y: 0, w: 200, h: 100 });
      expect(container.querySelectorAll('iframe').length, 'running').toBe(1);

      vi.advanceTimersByTime(PLUGIN_REFRESH_MS);
      await settle();
      expectRequest('GET', '/api/plugins', 'refresh').flush({ items: [] });
      await Promise.resolve();

      expect(container.querySelectorAll('iframe').length, 'frames gone (S3.10)').toBe(0);
      expect(plugins.blockOptions(), 'no options').toEqual([]);
    });

    it('when the tab becomes visible then the list is read again and a failure keeps what runs', async () => {
      await attach([anEnabledPlugin()]);

      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      expectRequest('GET', '/api/plugins', 'refresh').flush(
        { code: 'INTERNAL_ERROR', status: 500 },
        { status: 500, statusText: 'Error' },
      );
      await Promise.resolve();

      expect(plugins.blockOptions().length, 'kept').toBe(1);
    });
  });

  describe('services', () => {
    it('when a plugin writes its storage then the API is called with the version and a 409 is retried', async () => {
      const port = await frame(['storage']);

      port.postMessage({
        type: 'storage.set',
        v: 1,
        requestId: 's1',
        payload: { key: 'n', value: 3 },
      });
      await vi.waitFor(() => expectRequest('GET', STORAGE, 'read').flush({ data: {}, version: 4 }));
      await vi.waitFor(() =>
        expectRequest('PUT', STORAGE, 'write').flush(
          { code: 'CONFLICT', status: 409 },
          { status: 409, statusText: 'Conflict' },
        ),
      );
      await vi.waitFor(() =>
        expectRequest('GET', STORAGE, 'read again').flush({ data: { m: 1 }, version: 5 }),
      );
      let put: unknown;
      await vi.waitFor(() => {
        const req = expectRequest('PUT', STORAGE, 'write again');
        put = req.request.body;
        req.flush({ data: { m: 1, n: 3 }, version: 6 });
      });

      expect(put, 'merged with the new version').toEqual({ data: { m: 1, n: 3 }, version: 5 });
      expect(await replyTo('s1'), 'done').toEqual({});
    });

    it('when a plugin shows a toast then the app shows it as text with the plugin id', async () => {
      const port = await frame(['ui.toast']);

      port.postMessage({
        type: 'ui.toast',
        v: 1,
        requestId: 't',
        payload: { level: 'error', message: '<b>x</b>' },
      });
      await replyTo('t');

      expect(TestBed.inject(Toasts).toasts()[0]?.message, 'toast').toBe(`Plugin ${ID}: <b>x</b>`);
    });

    it('when a plugin wants to open a link then the user is asked with the host and it opens without opener', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const port = await frame(['ui.openLink']);

      port.postMessage({
        type: 'ui.openLink',
        v: 1,
        requestId: 'l',
        payload: { url: 'https://example.org/a?b=1' },
      });
      await vi.waitFor(() => expect(plugins.linkPrompt()?.host, 'asked').toBe('example.org'));
      plugins.linkPrompt()?.answer(true);

      expect(await replyTo('l'), 'opened').toEqual({ opened: true });
      expect(open, 'noopener').toHaveBeenCalledWith(
        'https://example.org/a?b=1',
        '_blank',
        'noopener,noreferrer',
      );
      open.mockRestore();
    });
  });

  describe('toPluginError', () => {
    it.each([
      [409, 'CONFLICT'],
      [413, 'TOO_LARGE'],
      [403, 'NOT_ALLOWED'],
      [404, 'NOT_FOUND'],
      [429, 'TOO_MANY_REQUESTS'],
      [500, 'UNAVAILABLE'],
    ])('when the API answers %d then the plugin gets %s', (status, code) => {
      const error = new ApiError(
        { code: 'X', status, title: 'x', timestamp: '' },
        undefined,
        undefined as never,
      );

      expect(toPluginError(error).code, 'code').toBe(code);
      expect(toPluginError(new Error('x')).code, 'anything else').toBe('UNAVAILABLE');
    });
  });
});
