import { BoardEngine } from '../engine';
import { BoardDoc, PluginError, isPlainJson, withinBound } from '@apps/drawboard-engine';
import {
  BoardRoleName,
  EnabledPluginInfo,
  PluginHost,
  PluginServices,
  PluginSession,
  validatePlugin,
} from './plugin-host';

const SHA = 'a'.repeat(64);
const PSEUDONYM = 'u3vJk01234567890123456789012345678901234567';
const ID = 'org.example.counter';
const TYPE = `${ID}.counter`;

function aPlugin(overrides: Partial<EnabledPluginInfo> = {}): EnabledPluginInfo {
  return {
    id: ID,
    version: '1.0.0',
    assetBase: `/plugin-assets/${ID}/1.0.0/${SHA}/`,
    entry: 'index.js',
    integrity: 'sha384-abc',
    blockTypes: [{ type: TYPE, label: 'Counter', defaultWidth: 200, defaultHeight: 120 }],
    grantedCapabilities: [],
    userPseudonym: PSEUDONYM,
    ...overrides,
  };
}

/** A plugin with the given id and block type names (each `<id>.<name>`). */
function pluginNamed(id: string, ...names: string[]): EnabledPluginInfo {
  return aPlugin({
    id,
    assetBase: `/plugin-assets/${id}/1.0.0/${SHA}/`,
    blockTypes: names.map((n) => ({
      type: `${id}.${n}`,
      label: n,
      defaultWidth: 200,
      defaultHeight: 120,
    })),
  });
}

/** A JSON text parsed so that `__proto__` is an own member, as structured clone delivers it. */
const withOwn = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

const grants = (...names: string[]) => names.map((name) => ({ name }));

/** The plugin side of one frame: the port the host handed over and what came through it. */
interface Frame {
  iframe: HTMLIFrameElement;
  port: MessagePort;
  inbox: Record<string, unknown>[];
  send(message: unknown, transfer?: Transferable[]): void;
  request(type: string, payload: Record<string, unknown>, id?: string): void;
}

describe('PluginHost', () => {
  let container: HTMLElement;
  let board: BoardDoc;
  let engine: BoardEngine;
  let host: PluginHost;
  let frames: Frame[];
  let role: BoardRoleName;
  let guest: boolean;
  let colorScheme: 'light' | 'dark';
  let visible: boolean;
  let services: PluginServices & {
    toasts: [string, string, string][];
    opened: string[];
    store: { data: Record<string, unknown>; version: number };
    conflicts: number;
    confirm: boolean;
  };

  function setUp(options: { maxFrames?: number; pluginOrigin?: string } = {}): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    frames = [];
    role = 'EDITOR';
    guest = false;
    colorScheme = 'light';
    visible = true;
    const store = { data: {} as Record<string, unknown>, version: 0 };
    services = {
      toasts: [],
      opened: [],
      store,
      conflicts: 0,
      confirm: true,
      getStorage: () => Promise.resolve({ data: { ...store.data }, version: store.version }),
      putStorage: (_id, data, version) => {
        if (services.conflicts > 0 || version !== store.version) {
          services.conflicts--;
          return Promise.reject(new PluginError('CONFLICT', 'stale'));
        }
        store.data = data;
        store.version++;
        return Promise.resolve();
      },
      toast: (id, level, message) => services.toasts.push([id, level, message]),
      confirmLink: () => Promise.resolve(services.confirm),
      openLink: (url) => services.opened.push(url),
    };
    const session: PluginSession = {
      boardId: 'board-1',
      boardTitle: () => 'Sprint',
      role: () => role,
      userName: () => 'Alice',
      guest: () => guest,
      locale: 'de-AT',
      colorScheme: () => colorScheme,
    };
    host = new PluginHost(engine, session, services, {
      maxFrames: options.maxFrames,
      pluginOrigin: options.pluginOrigin,
      observe: (_el, onChange) => {
        onChange(visible);
        return () => undefined;
      },
      connect: (iframe, port) => {
        const frame: Frame = {
          iframe,
          port,
          inbox: [],
          send: (m, t) => port.postMessage(m, t ?? []),
          request: (type, payload, id = `p-${frame.inbox.length}-${Math.random()}`) =>
            port.postMessage({ type, v: 1, requestId: id, payload }),
        };
        port.onmessage = (e: MessageEvent) => frame.inbox.push(e.data as Record<string, unknown>);
        frames.push(frame);
      },
    });
  }

  afterEach(() => {
    host?.destroy();
    for (const f of frames ?? []) {
      f.port.close();
    }
    engine?.destroy();
    board?.destroy();
    container?.remove();
    vi.useRealTimers();
  });

  const iframes = (): HTMLIFrameElement[] => Array.from(container.querySelectorAll('iframe'));
  const addBlock = (props: Record<string, unknown> = {}): string =>
    board.addBlock({ type: TYPE, x: 0, y: 0, w: 200, h: 120, props });

  /** Fires the load event jsdom does not fire and returns the plugin side of the frame. */
  async function start(iframe = iframes().at(-1) as HTMLIFrameElement): Promise<Frame> {
    iframe.dispatchEvent(new Event('load'));
    const frame = frames.find((f) => f.iframe === iframe) as Frame;
    await vi.waitFor(() => expect(frame.inbox.length, 'init arrived').toBeGreaterThan(0));
    return frame;
  }

  /** The reply to `id` once it arrived. */
  async function reply(frame: Frame, id: string): Promise<Record<string, unknown>> {
    let found: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      found = frame.inbox.find((m) => m['requestId'] === id);
      expect(found, `reply to ${id}`).toBeDefined();
    });
    return found as Record<string, unknown>;
  }

  async function ask(
    frame: Frame,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<{ type: string; payload: Record<string, unknown> }> {
    const id = `r${Math.random().toString(36).slice(2, 10)}`;
    frame.request(type, payload, id);
    const answer = await reply(frame, id);
    return {
      type: answer['type'] as string,
      payload: answer['payload'] as Record<string, unknown>,
    };
  }

  async function running(
    capabilities: string[] = [],
    props = {},
  ): Promise<{ id: string; frame: Frame }> {
    setUp();
    host.setPlugins([aPlugin({ grantedCapabilities: grants(...capabilities) })]);
    const id = addBlock(props);
    return { id, frame: await start() };
  }

  describe('trust (S3.1)', () => {
    it.each([
      ['an id in the reserved core namespace', { id: 'core.evil' }],
      [
        'a block type outside its namespace',
        {
          blockTypes: [{ type: 'core.sticky', label: 'x', defaultWidth: 100, defaultHeight: 100 }],
        },
      ],
      ['an asset base outside /plugin-assets/', { assetBase: '/api/' }],
      [
        'an asset base of another plugin',
        { assetBase: `/plugin-assets/org.other.x/1.0.0/${SHA}/` },
      ],
      [
        'an asset base on a foreign host',
        { assetBase: `https://evil.example/plugin-assets/${ID}/1.0.0/${SHA}/` },
      ],
      ['a malformed pseudonym', { userPseudonym: 'alice' }],
      [
        'a default size out of range',
        {
          blockTypes: [{ type: TYPE, label: 'x', defaultWidth: 5, defaultHeight: 100 }],
        },
      ],
    ])('when a plugin has %s then it is refused', (_name, patch) => {
      expect(
        validatePlugin(aPlugin(patch as Partial<EnabledPluginInfo>), undefined),
        'refused',
      ).toBeUndefined();
    });

    it('when a plugin origin is configured then frames come only from it', () => {
      const origin = 'https://plugins.example.org';
      const remote = `${origin}/plugin-assets/${ID}/1.0.0/${SHA}/`;

      expect(validatePlugin(aPlugin({ assetBase: remote }), origin)?.assetBase, 'on it').toBe(
        remote,
      );
      expect(validatePlugin(aPlugin(), origin), 'not from the app origin').toBeUndefined();
    });

    it('when a plugin claims to be trusted then it still runs sandboxed', () => {
      setUp();
      const claim = { ...aPlugin(), trusted: true } as EnabledPluginInfo;

      host.setPlugins([claim]);
      addBlock();

      expect(iframes()[0]?.getAttribute('sandbox'), 'sandboxed').toBe('allow-scripts');
      expect(container.querySelector('[data-block-type] script'), 'nothing in the page').toBeNull();
    });

    it('when a plugin type is registered then it is not trusted (so the renderer gives it no host)', () => {
      setUp();

      host.setPlugins([aPlugin()]);

      const type = engine.registry.get(TYPE);
      expect(type, 'registered').toBeDefined();
      expect(type?.trusted, 'trusted flag').toBeUndefined();
    });

    it('when a refused plugin is listed then its blocks stay placeholders with their data', () => {
      setUp();
      host.setPlugins([aPlugin({ assetBase: '/api/' })]);

      const id = addBlock({ count: 3 });

      expect(iframes().length, 'no frame').toBe(0);
      expect(engine.blockElement(id)?.textContent, 'placeholder').toContain(`Plugin: org.example`);
      expect(board.getBlock(id)?.props, 'data').toEqual({ count: 3 });
    });
  });

  describe('frames (S3.2, S3.11)', () => {
    it('when a plugin block is on screen then it gets exactly the sandbox attributes and a badge', () => {
      setUp();
      host.setPlugins([aPlugin()]);

      const id = addBlock();

      const iframe = iframes()[0] as HTMLIFrameElement;
      expect(iframe.getAttribute('sandbox'), 'only scripts').toBe('allow-scripts');
      expect(iframe.getAttribute('allow'), 'no permissions').toBe('');
      expect(iframe.getAttribute('referrerpolicy'), 'no referrer').toBe('no-referrer');
      expect(iframe.getAttribute('loading'), 'lazy').toBe('lazy');
      expect(iframe.getAttribute('src'), 'generated frame document').toBe(
        `/plugin-assets/${ID}/1.0.0/${SHA}/__drawboard/frame.html`,
      );
      expect(iframe.style.visibility, 'hidden until ready').toBe('hidden');
      expect(engine.blockElement(id)?.querySelector('.be-plugin-badge')?.textContent, 'badge').toBe(
        `Plugin: ${ID}`,
      );
    });

    it('when more than 50 plugin blocks are on screen then the rest waits for a free frame', () => {
      setUp();
      host.setPlugins([aPlugin()]);

      const ids = Array.from({ length: 51 }, () => addBlock());

      expect(iframes().length, 'at most 50').toBe(50);
      expect(host.frameCount, 'counted').toBe(50);
      expect(engine.blockElement(ids[50] as string)?.textContent, 'waiting').toContain('Paused');
      board.deleteItems([ids[0] as string]);
      expect(iframes().length, 'the waiting one got the free frame').toBe(50);
      expect(
        engine.blockElement(ids[50] as string)?.querySelector('iframe'),
        'its frame',
      ).not.toBeNull();
    });

    it('when a plugin block is off screen then it has no frame', () => {
      setUp();
      visible = false;
      host.setPlugins([aPlugin()]);

      addBlock();

      expect(iframes().length, 'no frame').toBe(0);
    });

    it('when the plugin does not answer init with ready in 10 s then the frame is replaced', async () => {
      setUp();
      host.setPlugins([aPlugin()]);
      const id = addBlock();
      await start();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // the timer was set with real timers before: start a second block under fake ones
      const late = addBlock();
      iframes().at(-1)?.dispatchEvent(new Event('load'));

      vi.advanceTimersByTime(10_000);

      expect(engine.blockElement(late)?.textContent, 'did not start').toContain('did not start');
      expect(engine.blockElement(id)?.querySelector('iframe'), 'the other one runs').not.toBeNull();
    });

    it('when the plugin answers ready then the frame is shown', async () => {
      const { frame } = await running();

      frame.send({ type: 'ready', v: 1, payload: {} });

      await vi.waitFor(() => expect(frame.iframe.style.visibility, 'shown').toBe('visible'));
    });
  });

  describe('init (S3.8)', () => {
    it('when the frame loads then init carries the pseudonym, never the user id, and the grants', async () => {
      const { id, frame } = await running(['storage'], { count: 1 });

      const init = frame.inbox[0] as { type: string; payload: Record<string, unknown> };
      expect(init.type, 'first message').toBe('init');
      expect(init.payload['user'], 'pseudonymous user').toEqual({
        id: PSEUDONYM,
        name: 'Alice',
        guest: false,
      });
      expect(init.payload['block'], 'own block').toEqual({
        id,
        type: TYPE,
        width: 200,
        height: 120,
        props: { count: 1 },
      });
      expect(init.payload['capabilities'], 'grants').toEqual([{ name: 'storage' }]);
      expect(init.payload['mode'], 'mode').toBe('edit');
      expect(init.payload['role'], 'role').toBe('EDITOR');
      expect(JSON.stringify(init), 'no token, no email').not.toMatch(/token|@|Bearer/i);
    });

    it('when the board becomes read-only or the block changes then the plugin hears about it', async () => {
      const { id, frame } = await running();

      engine.setReadOnly(true);
      board.setProp(id, 'count', 2);
      board.setGeometry(id, { w: 300 });

      await vi.waitFor(() =>
        expect(
          frame.inbox.map((m) => m['type']),
          'events',
        ).toEqual(['init', 'mode.changed', 'block.changed', 'block.changed']),
      );
      expect(frame.inbox[1]?.['payload'], 'view').toEqual({ mode: 'view' });
      expect(frame.inbox[2]?.['payload'], 'only the props').toEqual({ props: { count: 2 } });
      expect(frame.inbox[3]?.['payload'], 'only the width').toEqual({ width: 300 });
    });

    it('when the board changes its theme then the plugin hears the new colour scheme', async () => {
      const { frame } = await running();

      colorScheme = 'dark';
      engine.setTheme('dark');

      await vi.waitFor(() =>
        expect(
          frame.inbox.map((m) => m['type']),
          'events',
        ).toEqual(['init', 'theme.changed']),
      );
      expect(frame.inbox[1]?.['payload'], 'scheme').toEqual({ theme: { colorScheme: 'dark' } });
    });
  });

  describe('validation (S3.7)', () => {
    it.each([
      ['not an object', 'hello'],
      ['an extra member', { type: 'storage.keys', v: 1, requestId: 'a', payload: {}, x: 1 }],
      ['a wrong version', { type: 'storage.keys', v: 2, requestId: 'a', payload: {} }],
      ['an unknown type', { type: 'board.write', v: 1, requestId: 'a', payload: {} }],
      ['a request without id', { type: 'storage.keys', v: 1, payload: {} }],
      ['a bad request id', { type: 'storage.keys', v: 1, requestId: 'a b', payload: {} }],
      [
        'a payload that is not an object',
        { type: 'storage.keys', v: 1, requestId: 'a', payload: [] },
      ],
      [
        'a reply the host never asked for',
        { type: 'export.run.result', v: 1, requestId: 'a', payload: {} },
      ],
    ])('when the plugin sends %s then it is dropped without an answer', async (_name, message) => {
      const { frame } = await running(['storage']);

      frame.send(message);
      frame.request('storage.keys', {}, 'probe');
      await reply(frame, 'probe');

      expect(frame.inbox.filter((m) => m['requestId'] === 'a').length, 'no answer').toBe(0);
    });

    it('when a message is larger than 256 KiB or not plain JSON then it is dropped', async () => {
      const { frame } = await running(['ui.toast']);

      frame.request('ui.toast', { level: 'info', message: 'x'.repeat(300 * 1024) }, 'big');
      frame.send({
        type: 'ui.toast',
        v: 1,
        requestId: 'date',
        payload: { level: 'info', message: new Date() },
      });
      frame.send({
        type: 'ui.toast',
        v: 1,
        requestId: 'buf',
        payload: { level: 'info', message: new ArrayBuffer(2) },
      });
      frame.request('ui.toast', { level: 'info', message: 'ok' }, 'probe');
      await reply(frame, 'probe');

      expect(
        frame.inbox.filter((m) => ['big', 'date', 'buf'].includes(m['requestId'] as string)),
        'no answers',
      ).toEqual([]);
      expect(services.toasts, 'only the valid toast').toEqual([[ID, 'info', 'ok']]);
    });

    it('when a message transfers a port then it is dropped', async () => {
      const { frame } = await running(['ui.toast']);
      const extra = new MessageChannel();

      frame.send(
        { type: 'ui.toast', v: 1, requestId: 'port', payload: { level: 'info', message: 'x' } },
        [extra.port1],
      );
      frame.request('ui.toast', { level: 'info', message: 'ok' }, 'probe');
      await reply(frame, 'probe');

      expect(
        frame.inbox.some((m) => m['requestId'] === 'port'),
        'no answer',
      ).toBe(false);
      extra.port1.close();
      extra.port2.close();
    });

    it('when the payload breaks the schema then the answer is INVALID_PAYLOAD', async () => {
      const { frame } = await running(['block.resize', 'block.props']);

      const resize = await ask(frame, 'block.resize', { width: 10, height: 100 });
      const other = await ask(frame, 'block.setProps', { props: {}, blockId: 'another' });

      expect(resize.payload['code'], 'range').toBe('INVALID_PAYLOAD');
      expect(other.payload['code'], 'no block id to aim at another block').toBe('INVALID_PAYLOAD');
    });

    it('when more than 100 messages arrive in a burst then the excess is dropped', async () => {
      const { frame } = await running(['ui.toast']);

      const started = performance.now();
      for (let i = 0; i < 130; i++) {
        frame.request('ui.toast', { level: 'info', message: `m${i}` }, `t${i}`);
      }
      await reply(frame, 't99');
      await new Promise((r) => setTimeout(r, 20));
      // the bucket refills 100 tokens per second: on a slow runner a few may come back meanwhile
      const refilled = Math.ceil(((performance.now() - started) / 1000) * 100);

      expect(services.toasts.length, 'at most the burst plus the refill').toBeLessThanOrEqual(
        100 + refilled,
      );
      expect(services.toasts.length, 'the burst passes').toBeGreaterThan(90);
      expect(services.toasts.length, 'the excess is dropped').toBeLessThan(130);
    });

    it('when more than 32 requests are pending then the next one is refused', async () => {
      const { frame } = await running(['storage']);
      services.getStorage = () => new Promise(() => undefined);

      for (let i = 0; i < 33; i++) {
        frame.request('storage.keys', {}, `k${i}`);
      }

      const refused = await reply(frame, 'k32');
      expect((refused['payload'] as Record<string, unknown>)['code'], 'refused').toBe(
        'TOO_MANY_REQUESTS',
      );
    });

    it('when the frame sends more than 500 bad messages in a minute then it is stopped', async () => {
      const { id, frame } = await running();

      for (let i = 0; i < 520; i++) {
        frame.send({ nonsense: i });
      }

      await vi.waitFor(() => expect(iframes().length, 'frame removed').toBe(0));
      expect(engine.blockElement(id)?.textContent, 'placeholder').toContain('stopped');
    });

    it('when the frame navigates itself then it gets no second port and is stopped', async () => {
      const { id, frame } = await running();

      frame.iframe.dispatchEvent(new Event('load'));

      expect(frames.length, 'one port only').toBe(1);
      expect(engine.blockElement(id)?.textContent, 'stopped').toContain('stopped');
    });

    it('when a page posts a forged request to the window then the host does not listen', async () => {
      const { id } = await running(['block.props']);

      window.postMessage(
        { type: 'block.setProps', v: 1, requestId: 'x', payload: { props: { pwned: true } } },
        '*',
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'block.setProps',
            v: 1,
            requestId: 'y',
            payload: { props: { pwned: true } },
          },
        }),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(board.getBlock(id)?.props, 'unchanged').toEqual({});
    });
  });

  describe('capabilities (S3.8)', () => {
    it.each([
      ['block.setProps', { props: {} }],
      ['block.resize', { width: 100, height: 100 }],
      ['board.read', {}],
      ['ui.toast', { level: 'info', message: 'hi' }],
      ['ui.openLink', { url: 'https://example.org' }],
      ['storage.get', { key: 'a' }],
      ['storage.set', { key: 'a', value: 1 }],
      ['storage.keys', {}],
      ['export.register', { formats: [] }],
      ['import.register', { mediaType: 'text/csv', label: 'CSV', extensions: ['.csv'] }],
    ])(
      'when %s is not granted then the answer is CAPABILITY_NOT_GRANTED',
      async (type, payload) => {
        const { frame } = await running([]);

        const answer = await ask(frame, type, payload);

        expect(answer.type, 'error').toBe('error');
        expect(answer.payload['code'], 'code').toBe('CAPABILITY_NOT_GRANTED');
      },
    );

    it('when the plugin sets props then they replace those of its own block', async () => {
      const { id, frame } = await running(['block.props'], { old: 1 });

      const answer = await ask(frame, 'block.setProps', { props: { count: 5, list: [1, 'a'] } });

      expect(answer.type, 'ok').toBe('block.setProps.result');
      expect(board.getBlock(id)?.props, 'replaced').toEqual({ count: 5, list: [1, 'a'] });
    });

    it('when the props are larger than 64 KiB then nothing is written', async () => {
      const { id, frame } = await running(['block.props']);

      const answer = await ask(frame, 'block.setProps', { props: { big: 'x'.repeat(70_000) } });

      expect(answer.payload['code'], 'too large').toBe('TOO_LARGE');
      expect(board.getBlock(id)?.props, 'unchanged').toEqual({});
    });

    it.each([
      ['a viewer', 'VIEWER' as BoardRoleName, false],
      ['a commenter', 'COMMENTER' as BoardRoleName, false],
      ['an editor on a read-only board', 'EDITOR' as BoardRoleName, true],
    ])('when %s asks to write then it is NOT_ALLOWED', async (_name, r, readOnly) => {
      const { id, frame } = await running(['block.props', 'block.resize']);
      role = r;
      engine.setReadOnly(readOnly);

      const props = await ask(frame, 'block.setProps', { props: { x: 1 } });
      const resize = await ask(frame, 'block.resize', { width: 300, height: 200 });

      expect([props.payload['code'], resize.payload['code']], 'refused').toEqual([
        'NOT_ALLOWED',
        'NOT_ALLOWED',
      ]);
      expect(board.getBlock(id)?.w, 'size unchanged').toBe(200);
    });

    it('when the plugin resizes its block then the applied size comes back', async () => {
      const { id, frame } = await running(['block.resize']);

      const answer = await ask(frame, 'block.resize', { width: 320, height: 240 });

      expect(answer.payload, 'applied').toEqual({ width: 320, height: 240 });
      expect(board.getBlock(id)?.w, 'written').toBe(320);
    });

    it('when the plugin reads the board then it gets structure and text, props only of its own types', async () => {
      const { id, frame } = await running(['board.read'], { count: 1 });
      const sticky = board.addBlock({
        type: 'core.sticky',
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        props: { color: '#fde68a' },
        text: 'hello',
      });
      board.addConnector({ block: id, anchor: 'auto' }, { x: 5, y: 6 });

      const answer = await ask(frame, 'board.read', {});

      const blocks = answer.payload['blocks'] as Record<string, unknown>[];
      expect(answer.payload['board'], 'board').toEqual({ id: 'board-1', title: 'Sprint' });
      expect(blocks.find((b) => b['id'] === id)?.['props'], 'own props').toEqual({ count: 1 });
      expect(
        blocks.find((b) => b['id'] === sticky),
        'other block',
      ).toEqual({
        id: sticky,
        type: 'core.sticky',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        rotation: 0,
        text: 'hello',
      });
      expect(answer.payload['nextCursor'], 'one page').toBeUndefined();
    });

    it('when the board has more than 500 blocks then it is read in pages', async () => {
      const { frame } = await running(['board.read']);
      for (let i = 0; i < 520; i++) {
        board.addBlock({ type: 'core.text', x: i, y: 0, w: 10, h: 10 });
      }

      const first = await ask(frame, 'board.read', {});
      const second = await ask(frame, 'board.read', {
        cursor: first.payload['nextCursor'] as string,
      });

      expect((first.payload['blocks'] as unknown[]).length, 'first page').toBe(500);
      expect((second.payload['blocks'] as unknown[]).length, 'rest').toBe(21);
      expect(second.payload['nextCursor'], 'done').toBeUndefined();
    });

    it('when the plugin shows a toast then the text goes to the app as text', async () => {
      const { frame } = await running(['ui.toast']);

      await ask(frame, 'ui.toast', { level: 'warning', message: '<img src=x onerror=alert(1)>' });

      expect(services.toasts, 'as given, rendered as text by the app').toEqual([
        [ID, 'warning', '<img src=x onerror=alert(1)>'],
      ]);
    });

    it('when the plugin opens a link then the user is asked and it opens without opener', async () => {
      const { frame } = await running(['ui.openLink']);

      const yes = await ask(frame, 'ui.openLink', { url: 'https://example.org/help' });
      services.confirm = false;
      const no = await ask(frame, 'ui.openLink', { url: 'https://example.org/other' });
      const js = await ask(frame, 'ui.openLink', { url: 'javascript:alert(1)' });

      expect(yes.payload, 'opened').toEqual({ opened: true });
      expect(services.opened, 'only the confirmed one').toEqual(['https://example.org/help']);
      expect(no.payload['code'], 'declined').toBe('CANCELLED');
      expect(js.payload['code'], 'no javascript:').toBe('INVALID_PAYLOAD');
    });

    it('when the plugin uses its storage then values are read, written and listed through the app', async () => {
      const { frame } = await running(['storage']);

      await ask(frame, 'storage.set', { key: 'votes', value: { a: 2 } });
      const get = await ask(frame, 'storage.get', { key: 'votes' });
      const keys = await ask(frame, 'storage.keys', {});
      await ask(frame, 'storage.set', { key: 'votes', value: null });
      const gone = await ask(frame, 'storage.get', { key: 'votes' });

      expect(get.payload, 'value').toEqual({ value: { a: 2 } });
      expect(keys.payload, 'keys').toEqual({ keys: ['votes'] });
      expect(gone.payload, 'deleted').toEqual({ value: null });
    });

    it('when the storage keeps changing underneath then the write gives up after 3 retries', async () => {
      const { frame } = await running(['storage']);
      services.conflicts = 10;

      const answer = await ask(frame, 'storage.set', { key: 'a', value: 1 });

      expect(answer.payload['code'], 'conflict').toBe('CONFLICT');
    });

    it('when a guest or a viewer writes the storage then it is NOT_ALLOWED, reading is fine', async () => {
      const { frame } = await running(['storage']);
      guest = true;

      const write = await ask(frame, 'storage.set', { key: 'a', value: 1 });
      const read = await ask(frame, 'storage.get', { key: 'a' });

      expect(write.payload['code'], 'guest write').toBe('NOT_ALLOWED');
      expect(read.type, 'read').toBe('storage.get.result');
    });

    it('when a value or the whole storage would be too large then nothing is written', async () => {
      const { frame } = await running(['storage']);
      services.store.data = { filler: 'x'.repeat(1_000_000) };

      const value = await ask(frame, 'storage.set', { key: 'a', value: 'x'.repeat(210 * 1024) });
      const total = await ask(frame, 'storage.set', { key: 'b', value: 'x'.repeat(100_000) });

      expect([value.payload['code'], total.payload['code']], 'too large').toEqual([
        'TOO_LARGE',
        'TOO_LARGE',
      ]);
      expect(services.store.version, 'nothing written').toBe(0);
    });

    it('when the storage key is malformed then the answer is INVALID_PAYLOAD', async () => {
      const { frame } = await running(['storage']);

      const answer = await ask(frame, 'storage.get', { key: '../x' });

      expect(answer.payload['code'], 'invalid').toBe('INVALID_PAYLOAD');
    });

    it('when an import is registered for another media type than granted then it is not granted', async () => {
      setUp();
      host.setPlugins([
        aPlugin({
          grantedCapabilities: [
            { name: 'import.register', value: 'text/csv' },
            { name: 'export.register' },
          ],
        }),
      ]);
      addBlock();
      const frame = await start();

      const other = await ask(frame, 'import.register', {
        mediaType: 'text/plain',
        label: 'x',
        extensions: ['.txt'],
      });
      const csv = await ask(frame, 'import.register', {
        mediaType: 'text/csv',
        label: 'x',
        extensions: ['.csv'],
      });
      const exp = await ask(frame, 'export.register', { formats: [] });

      expect(other.payload['code'], 'other type').toBe('CAPABILITY_NOT_GRANTED');
      expect([csv.payload['code'], exp.payload['code']], 'not on a block instance').toEqual([
        'NOT_ALLOWED',
        'NOT_ALLOWED',
      ]);
    });
  });

  describe('disabling (S3.10)', () => {
    it('when a plugin is disabled then all its frames go at once and its blocks keep their data', async () => {
      setUp();
      host.setPlugins([aPlugin()]);
      const a = addBlock({ n: 1 });
      addBlock({ n: 2 });
      const frame = await start(iframes()[0]);

      host.setPlugins([]);

      expect(iframes().length, 'no frame left').toBe(0);
      expect(engine.blockElement(a)?.textContent, 'placeholder').toContain('not available');
      expect(board.getBlock(a)?.props, 'data kept').toEqual({ n: 1 });
      expect(host.frameCount, 'budget freed').toBe(0);
      await vi.waitFor(() => expect(frame.inbox.at(-1)?.['type'], 'told').toBe('destroy'));
      expect(host.blockOptions(), 'no toolbar entries').toEqual([]);
    });

    it('when the plugin is enabled again then its blocks get frames again', () => {
      setUp();
      host.setPlugins([aPlugin()]);
      addBlock();
      host.setPlugins([]);

      host.setPlugins([aPlugin({ grantedCapabilities: grants('storage') })]);

      expect(iframes().length, 'frame back').toBe(1);
      expect(
        host.blockOptions().map((o) => o.label),
        'toolbar',
      ).toEqual(['Counter']);
    });
  });

  describe('block ownership (S3.8)', () => {
    const block = (type: string, props: Record<string, unknown> = {}): string =>
      board.addBlock({ type, x: 0, y: 0, w: 100, h: 100, props });

    it('when a plugin id is a prefix of another then its types are its declared ones only', async () => {
      setUp();
      const outer = validatePlugin(pluginNamed('org.b', 'x'), undefined);
      const foreign = block('org.b.c.x', { secret: 1 });
      const own = block('org.b.x', { mine: 1 });
      expect(outer?.own, 'declared types').toEqual(new Set(['org.b.x']));

      const write = host.execute(outer as never, foreign, 'block.setProps', { props: { p: 1 } });
      const read = (await host.execute(outer as never, own, 'board.read', {})) as {
        blocks: { id: string; props?: unknown }[];
      };

      await expect(write, 'cannot write a block of org.b.c').rejects.toMatchObject({
        code: 'NOT_ALLOWED',
      });
      expect(board.getBlock(foreign)?.props, 'untouched').toEqual({ secret: 1 });
      expect(read.blocks.find((b) => b.id === foreign)?.props, 'foreign props unseen').toBe(
        undefined,
      );
      expect(read.blocks.find((b) => b.id === own)?.props, 'own props seen').toEqual({ mine: 1 });
    });

    it('when a plugin declares a type of another plugin then it is dropped and the rest loads', () => {
      setUp();
      const thief = pluginNamed('org.thief', 'x');
      const first = pluginNamed('org.first', 'x');
      // org.thief may not declare org.first.x: outside its namespace, so refused outright
      const stolen = {
        ...thief,
        blockTypes: [...first.blockTypes, ...thief.blockTypes],
      } as EnabledPluginInfo;

      host.setPlugins([first, stolen, pluginNamed('org.third', 'y')]);

      expect(
        host.blockOptions().map((o) => o.type),
        'the others load',
      ).toEqual(['org.first.x', 'org.third.y']);
      expect(host.droppedPlugins, 'counted').toBe(1);
    });

    it('when a plugin declares a type in the namespace of a later plugin then the later one is dropped', () => {
      setUp();
      const wide = pluginNamed('org.b', 'x', 'c.x');

      host.setPlugins([wide, pluginNamed('org.b.c', 'x'), pluginNamed('org.d', 'y')]);

      expect(
        host.blockOptions().map((o) => o.type),
        'org.b keeps org.b.c.x',
      ).toEqual(['org.b.x', 'org.b.c.x', 'org.d.y']);
      expect(host.droppedPlugins, 'counted').toBe(1);
    });

    it.each([
      ['an extension of an accepted id', ['org.b', 'org.b.c'], ['org.b']],
      ['a dot-prefix of an accepted id', ['org.b.c', 'org.b'], ['org.b.c']],
      ['the same id twice', ['org.b', 'org.b'], ['org.b']],
    ])('when a plugin has %s then it is dropped', (_name, ids, kept) => {
      setUp();

      host.setPlugins([...ids, 'org.other'].map((id) => pluginNamed(id, 'x')));

      expect(
        host.blockOptions().map((o) => o.pluginId),
        'first wins, the rest loads',
      ).toEqual([...kept, 'org.other']);
      expect(host.droppedPlugins, 'counted').toBe(1);
    });

    it('when the registry refuses a plugin then the rest of the list still loads', () => {
      setUp();
      engine.registry.register({
        type: 'org.b.x',
        label: 'taken',
        defaultSize: { w: 1, h: 1 },
        defaultProps: {},
        render: () => ({ update: () => undefined, destroy: () => undefined }),
      });

      host.setPlugins([pluginNamed('org.b', 'x'), pluginNamed('org.c', 'y')]);

      expect(
        host.blockOptions().map((o) => o.pluginId),
        'only the loadable one',
      ).toEqual(['org.c']);
      expect(host.droppedPlugins, 'counted').toBe(1);

      host.setPlugins([pluginNamed('org.c', 'y')]);
      expect(host.blockOptions().length, 'consistent afterwards').toBe(1);
    });
  });

  describe('message size and forbidden keys (S3.7)', () => {
    const instanceOf = (): { dropped: number } =>
      [...(host as unknown as { views: Set<{ instance?: { dropped: number } }> }).views][0]
        ?.instance as { dropped: number };

    it('when a message carries a 10 MB string then it is refused fast and counted as a drop', async () => {
      const { frame } = await running(['ui.toast']);
      const before = instanceOf().dropped;

      frame.request('ui.toast', { level: 'info', message: 'x'.repeat(10_000_000) }, 'huge');
      frame.request('ui.toast', { level: 'info', message: 'ok' }, 'probe');
      await reply(frame, 'probe');

      expect(instanceOf().dropped - before, 'one drop').toBe(1);
      expect(services.toasts, 'only the small one').toEqual([[ID, 'info', 'ok']]);
    });

    it('when a value is huge then the bounded walk refuses it long before its end', () => {
      // counts the elements read instead of timing the walk (timings flake on a busy runner)
      let read = 0;
      const counting = new Proxy(new Array<number>(5_000_000).fill(1), {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            read++;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });

      expect(withinBound('x'.repeat(10_000_000), 256 * 1024), 'huge string').toBe(false);
      expect(withinBound(counting, 256 * 1024), 'huge array').toBe(false);
      const readForArray = read;
      read = 0;
      expect(withinBound({ list: counting }, 256 * 1024), 'object holding it').toBe(false);

      // two bytes per number: the walk stops after ~131 000 of 5 000 000 elements
      expect(readForArray, 'elements read for the array').toBeLessThanOrEqual(140_000);
      expect(read, 'elements read for the object').toBeLessThanOrEqual(140_000);
    });

    it('when a value is within the limit then the bounded walk accepts it', () => {
      expect(
        withinBound({ a: ['x'.repeat(200_000)], b: [1, true, null] }, 256 * 1024),
        'fits',
      ).toBe(true);
      expect(withinBound('x'.repeat(256 * 1024), 256 * 1024), 'string plus quotes').toBe(false);
    });

    it.each([
      ['at the top', '{"__proto__": 1}'],
      ['nested', '{"a": {"b": [{"constructor": 1}]}}'],
      ['prototype', '{"a": {"prototype": {}}}'],
    ])('when props carry a forbidden key %s then nothing is written', async (_n, json) => {
      const { id, frame } = await running(['block.props']);
      const props = withOwn(json);

      expect(isPlainJson(props), 'not plain JSON').toBe(false);
      frame.request('block.setProps', { props }, 'bad');
      frame.request('block.setProps', { props: { ok: 1 } }, 'good');
      await reply(frame, 'good');

      expect(
        frame.inbox.some((m) => m['requestId'] === 'bad'),
        'no answer',
      ).toBe(false);
      expect(board.getBlock(id)?.props, 'only the good one').toEqual({ ok: 1 });
    });

    it('when the host is asked to set props with a forbidden key then it answers INVALID_PAYLOAD', async () => {
      setUp();
      host.setPlugins([aPlugin()]);
      const id = addBlock();
      const plugin = validatePlugin(aPlugin(), undefined) as never;

      await expect(
        host.execute(plugin, id, 'block.setProps', { props: withOwn('{"x":{"__proto__":1}}') }),
        'refused',
      ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    });

    it.each(['__proto__', 'constructor', 'prototype'])(
      'when the storage key is %s then get and set answer INVALID_PAYLOAD',
      async (key) => {
        const { frame } = await running(['storage']);

        const get = await ask(frame, 'storage.get', { key });
        const set = await ask(frame, 'storage.set', { key, value: 1 });

        expect([get.payload['code'], set.payload['code']], 'invalid').toEqual([
          'INVALID_PAYLOAD',
          'INVALID_PAYLOAD',
        ]);
        expect(services.store.version, 'nothing written').toBe(0);
      },
    );

    it('when a storage value carries a forbidden key then the message is dropped', async () => {
      const { frame } = await running(['storage']);

      frame.request('storage.set', { key: 'a', value: withOwn('{"k":{"constructor":1}}') }, 'bad');
      frame.request('storage.keys', {}, 'probe');
      await reply(frame, 'probe');

      expect(
        frame.inbox.some((m) => m['requestId'] === 'bad'),
        'no answer',
      ).toBe(false);
      expect(services.store.version, 'nothing written').toBe(0);
    });

    it('when the stored data has no own member of that name then get answers null', async () => {
      setUp();
      host.setPlugins([aPlugin()]);
      const id = addBlock();
      const plugin = validatePlugin(aPlugin(), undefined) as never;
      services.store.data = { real: 1 };

      const inherited = await host.execute(plugin, id, 'storage.get', { key: 'constructor' });
      const own = await host.execute(plugin, id, 'storage.get', { key: 'real' });

      expect([inherited, own], 'own members only').toEqual([{ value: null }, { value: 1 }]);
    });
  });

  describe('self-navigation (S3.8)', () => {
    it('when one frame navigates itself then every frame of that plugin is stopped', async () => {
      setUp();
      host.setPlugins([aPlugin(), pluginNamed('org.other', 'x')]);
      const a = addBlock();
      const b = addBlock();
      const other = board.addBlock({ type: 'org.other.x', x: 0, y: 0, w: 100, h: 100 });
      const frame = await start(iframes()[0]);
      await start(iframes()[1]);
      await start(iframes()[2]);

      frame.iframe.dispatchEvent(new Event('load'));

      expect(iframes().length, 'only the other plugin keeps its frame').toBe(1);
      expect(engine.blockElement(a)?.textContent, 'says stopped').toContain('was stopped');
      expect(engine.blockElement(b)?.textContent, 'says stopped').toContain('was stopped');
      expect(
        engine.blockElement(other)?.querySelector('iframe'),
        'other plugin runs',
      ).not.toBeNull();
      expect(host.isStopped(ID), 'remembered').toBe(true);
      expect(host.frameCount, 'budget freed').toBe(1);
    });

    it('when a stopped plugin is listed again or a block is mounted then no frame starts', async () => {
      setUp();
      host.setPlugins([aPlugin()]);
      const first = addBlock();
      const frame = await start();
      frame.iframe.dispatchEvent(new Event('load'));

      host.setPlugins([aPlugin()]);
      host.setPlugins([aPlugin({ grantedCapabilities: grants('storage') })]);
      const later = addBlock();

      expect(iframes().length, 'no new frame').toBe(0);
      expect(engine.blockElement(first)?.textContent, 'still says stopped').toContain(
        'was stopped',
      );
      expect(engine.blockElement(later)?.textContent, 'new block says stopped').toContain(
        'was stopped',
      );
      expect(frames.length, 'no second port ever').toBe(1);
    });
  });
});
