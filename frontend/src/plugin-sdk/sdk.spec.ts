import { BoardEngine } from '../board-engine/engine';
import { BoardDoc, PluginError as HostError } from '@apps/drawboard-engine';
import { BoardRoleName, PluginHost, PluginServices } from '../board-engine/plugins/plugin-host';
import {
  FrameWindow,
  MessageEventLike,
  PluginContext,
  PluginError,
  connect,
  defineBlock,
} from './index';
import { mountCounter } from './samples/counter/counter';

const ID = 'org.example.counter';
const TYPE = `${ID}.counter`;

/** A frame's window as the SDK sees it: the board (parent) delivers the connect message. */
class FakeWindow implements FrameWindow {
  readonly parent = { name: 'board' };
  private readonly listeners = new Set<(event: MessageEventLike) => void>();

  addEventListener(_type: 'message', listener: (event: MessageEventLike) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEventLike) => void): void {
    this.listeners.delete(listener);
  }

  deliver(event: MessageEventLike): void {
    for (const l of [...this.listeners]) {
      l(event);
    }
  }

  get listening(): number {
    return this.listeners.size;
  }
}

describe('plugin SDK', () => {
  let container: HTMLElement;
  let board: BoardDoc;
  let engine: BoardEngine;
  let host: PluginHost;
  let win: FakeWindow;
  let ports: MessagePort[];
  let role: BoardRoleName;
  let store: { data: Record<string, unknown>; version: number };
  let toasts: string[];
  let confirm: boolean;

  function setUp(grants: string[]): string {
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    win = new FakeWindow();
    ports = [];
    role = 'EDITOR';
    store = { data: {}, version: 0 };
    toasts = [];
    confirm = true;
    const services: PluginServices = {
      getStorage: () => Promise.resolve({ data: { ...store.data }, version: store.version }),
      putStorage: (_id, data, version) => {
        if (version !== store.version) {
          return Promise.reject(new HostError('CONFLICT', 'stale'));
        }
        store = { data, version: version + 1 };
        return Promise.resolve();
      },
      toast: (_id, level, message) => toasts.push(`${level}: ${message}`),
      confirmLink: () => Promise.resolve(confirm),
      openLink: () => undefined,
    };
    host = new PluginHost(
      engine,
      {
        boardId: 'board-1',
        boardTitle: () => 'Sprint',
        role: () => role,
        userName: () => 'Alice',
        guest: () => false,
        locale: 'en',
        colorScheme: () => 'light',
      },
      services,
      {
        observe: (_el, onChange) => {
          onChange(true);
          return () => undefined;
        },
        connect: (_iframe, port) => {
          ports.push(port);
          win.deliver({ source: win.parent, data: { type: 'connect', v: 1 }, ports: [port] });
        },
      },
    );
    host.setPlugins([
      {
        id: ID,
        version: '1.0.0',
        assetBase: `/plugin-assets/${ID}/1.0.0/${'d'.repeat(64)}/`,
        entry: 'index.js',
        integrity: 'sha384-x',
        blockTypes: [{ type: TYPE, label: 'Counter', defaultWidth: 200, defaultHeight: 140 }],
        grantedCapabilities: grants.map((name) => ({ name })),
        userPseudonym: 'q'.repeat(43),
      },
    ]);
    return board.addBlock({ type: TYPE, x: 0, y: 0, w: 200, h: 140, props: { count: 2 } });
  }

  /** Connects the SDK to the frame of the block that was just added. */
  async function started(grants: string[] = []): Promise<{ ctx: PluginContext; id: string }> {
    const id = setUp(grants);
    const pending = connect({ window: win, timeoutMs: 2_000 });
    container.querySelector('iframe')?.dispatchEvent(new Event('load'));
    return { ctx: await pending, id };
  }

  afterEach(() => {
    host.destroy();
    ports.forEach((p) => p.close());
    engine.destroy();
    board.destroy();
    container.remove();
  });

  describe('connect', () => {
    it('when the board connects then the context carries init with the pseudonym and the block', async () => {
      const { ctx, id } = await started(['storage']);

      expect(ctx.init.user.id, 'pseudonym').toBe('q'.repeat(43));
      expect(ctx.init.block?.id, 'block').toBe(id);
      expect(ctx.props(), 'props').toEqual({ count: 2 });
      expect(ctx.can('storage'), 'granted').toBe(true);
      expect(ctx.can('block.props'), 'not granted').toBe(false);
      expect(ctx.canEdit(), 'editor in edit mode').toBe(true);
      expect(win.listening, 'stops listening on the window').toBe(0);
    });

    it('when a message comes from somewhere else than the parent or without a port then it is ignored', async () => {
      setUp([]);
      const pending = connect({ window: win });
      const fake = new MessageChannel();

      win.deliver({
        source: { name: 'evil' },
        data: { type: 'connect', v: 1 },
        ports: [fake.port1],
      });
      win.deliver({ source: win.parent, data: { type: 'connect', v: 1 }, ports: [] });
      win.deliver({ source: win.parent, data: { type: 'connect', v: 2 }, ports: [fake.port1] });

      expect(win.listening, 'still waiting for the board').toBe(1);
      container.querySelector('iframe')?.dispatchEvent(new Event('load'));
      const ctx = await pending;
      expect(ctx.init.plugin.id, 'the real board').toBe(ID);
      fake.port1.close();
      fake.port2.close();
    });

    it('when the plugin is ready then the board shows its frame', async () => {
      const { ctx } = await started();

      ctx.ready();

      await vi.waitFor(() =>
        expect(container.querySelector('iframe')?.style.visibility, 'shown').toBe('visible'),
      );
    });

    it('when defineBlock is used then it renders into the root and says ready', async () => {
      setUp([]);
      const root = document.createElement('div');
      const render = vi.fn((el: HTMLElement) => el.append('hi'));

      const pending = defineBlock(render, { window: win, root });
      container.querySelector('iframe')?.dispatchEvent(new Event('load'));
      await pending;

      expect(root.textContent, 'rendered').toBe('hi');
      await vi.waitFor(() =>
        expect(container.querySelector('iframe')?.style.visibility, 'ready').toBe('visible'),
      );
    });
  });

  describe('requests', () => {
    it('when props are set then the block changes, and changes by others arrive as events', async () => {
      const { ctx, id } = await started(['block.props']);
      const seen: unknown[] = [];
      ctx.on('block.changed', (c) => seen.push(c));

      await ctx.setProps({ count: 3 });
      board.setProp(id, 'count', 7);

      expect(board.getBlock(id)?.props, 'written').toEqual({ count: 7 });
      await vi.waitFor(() => expect(ctx.props(), 'followed').toEqual({ count: 7 }));
      expect(seen.at(-1), 'event').toEqual({ props: { count: 7 } });
    });

    it('when a capability is missing then the request fails with its code', async () => {
      const { ctx } = await started([]);

      await expect(ctx.setProps({ count: 1 }), 'refused').rejects.toEqual(
        expect.objectContaining({ name: 'PluginError', code: 'CAPABILITY_NOT_GRANTED' }),
      );
    });

    it('when the board is read then every page is collected', async () => {
      const { ctx } = await started(['board.read']);
      for (let i = 0; i < 600; i++) {
        board.addBlock({ type: 'core.text', x: i, y: 0, w: 10, h: 10, text: `t${i}` });
      }

      const snapshot = await ctx.readBoard();

      expect(snapshot.blocks.length, 'all blocks').toBe(601);
      expect(snapshot.board.title, 'title').toBe('Sprint');
    });

    it('when the storage is used then values round-trip', async () => {
      const { ctx } = await started(['storage']);

      await ctx.storage.set('votes', { yes: 2 });

      expect(await ctx.storage.get('votes'), 'value').toEqual({ yes: 2 });
      expect(await ctx.storage.keys(), 'keys').toEqual(['votes']);
      expect(await ctx.storage.get('none'), 'missing').toBeNull();
    });

    it('when the user declines a link then openLink answers false', async () => {
      const { ctx } = await started(['ui.openLink']);
      confirm = false;

      expect(await ctx.openLink('https://example.org'), 'declined').toBe(false);
      confirm = true;
      expect(await ctx.openLink('https://example.org'), 'opened').toBe(true);
    });

    it('when the plugin resizes and toasts then the board follows', async () => {
      const { ctx, id } = await started(['block.resize', 'ui.toast']);

      expect(await ctx.resize(300, 200), 'applied').toEqual({ width: 300, height: 200 });
      await ctx.toast('success', 'Done');

      expect(board.getBlock(id)?.w, 'width').toBe(300);
      expect(ctx.size(), 'size').toEqual({ width: 300, height: 200 });
      expect(toasts, 'toast').toEqual(['success: Done']);
    });

    it('when the board does not answer in time then the request fails with TIMEOUT', async () => {
      const channel = new MessageChannel();
      const lonely = new FakeWindow();
      const pending = connect({ window: lonely, timeoutMs: 30 });
      lonely.deliver({
        source: lonely.parent,
        data: { type: 'connect', v: 1 },
        ports: [channel.port2],
      });
      channel.port1.postMessage({
        type: 'init',
        v: 1,
        payload: { capabilities: [], board: { id: 'b' }, mode: 'edit', role: 'EDITOR' },
      });
      const ctx = await pending;

      await expect(ctx.storage.keys(), 'timeout').rejects.toBeInstanceOf(PluginError);
      channel.port1.close();
      channel.port2.close();
      setUp([]); // for afterEach
    });
  });

  describe('sample counter', () => {
    it('when an editor clicks + then the count is written, the clicks are stored and reset toasts', async () => {
      const { ctx, id } = await started(['block.props', 'storage', 'ui.toast']);
      const root = document.createElement('div');

      mountCounter(root, ctx);
      const buttons = Array.from(root.querySelectorAll('button'));
      expect(root.querySelector('output')?.textContent, 'from props').toBe('2');
      buttons.find((b) => b.textContent === '+')?.click();

      await vi.waitFor(() => expect(board.getBlock(id)?.props, 'count').toEqual({ count: 3 }));
      await vi.waitFor(() => expect(store.data, 'clicks').toEqual({ clicks: 1 }));
      buttons.find((b) => b.textContent === 'Reset')?.click();
      await vi.waitFor(() => expect(toasts, 'toast').toEqual(['info: The counter was reset.']));
      expect(board.getBlock(id)?.props, 'reset').toEqual({ count: 0 });
    });

    it('when the user is a viewer then the counter shows the number without buttons', async () => {
      setUp(['block.props']);
      role = 'VIEWER';
      const pending = connect({ window: win });
      container.querySelector('iframe')?.dispatchEvent(new Event('load'));
      const ctx = await pending;
      const root = document.createElement('div');

      mountCounter(root, ctx);

      expect(root.querySelector('output')?.textContent, 'number').toBe('2');
      expect(
        (root.querySelector('button')?.parentElement as HTMLElement).style.display,
        'no buttons',
      ).toBe('none');
    });

    it('when writing fails then the counter shows the code', async () => {
      const { ctx } = await started(['block.props']);
      const root = document.createElement('div');
      mountCounter(root, ctx);
      engine.setReadOnly(true);
      await vi.waitFor(() => expect(ctx.mode(), 'view').toBe('view'));

      // the buttons are hidden now; a click from an old reference still asks the board
      Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent === '+')
        ?.click();

      await vi.waitFor(() =>
        expect(root.querySelector('small:last-child')?.textContent, 'error').toContain(
          'NOT_ALLOWED',
        ),
      );
    });
  });
});
