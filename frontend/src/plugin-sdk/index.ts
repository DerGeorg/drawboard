/**
 * Drawboard plugin SDK (plugin API 1.0.0) - for plugin authors.
 *
 * A plugin runs in a sandboxed frame of the board (no cookies, no storage, no access to the
 * board's page) and talks to the board only through the MessageChannel the board hands it. This
 * module does the connecting and the message protocol of api `docs/plugin-protocol.md`, typed:
 *
 * ```ts
 * import { defineBlock } from '@apps/drawboard-plugin-sdk';
 *
 * defineBlock((root, ctx) => {
 *   const label = document.createElement('span');
 *   const render = () => (label.textContent = String(ctx.props()['count'] ?? 0));
 *   ctx.on('block.changed', render);
 *   render();
 *   root.append(label);
 * });
 * ```
 *
 * No dependencies, no DOM access outside the frame; bundle it into the plugin's entry module.
 */

export const API_VERSION = '1.0.0';

export type CapabilityName =
  | 'block.props'
  | 'block.resize'
  | 'board.read'
  | 'export.register'
  | 'import.register'
  | 'ui.toast'
  | 'ui.openLink'
  | 'storage'
  | 'network';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface InitPayload {
  readonly apiVersion: string;
  readonly instance: 'block' | 'service';
  readonly plugin: { readonly id: string; readonly version: string };
  readonly block?: {
    readonly id: string;
    readonly type: string;
    readonly width: number;
    readonly height: number;
    readonly props: Record<string, unknown>;
  };
  readonly board: { readonly id: string };
  readonly mode: 'view' | 'edit';
  readonly role: 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER';
  /** `user.id` is a pseudonym for this plugin, never the real user id. */
  readonly user: { readonly id: string; readonly name: string; readonly guest: boolean };
  readonly locale: string;
  readonly theme: { readonly colorScheme: 'light' | 'dark' };
  readonly capabilities: readonly { readonly name: CapabilityName; readonly value?: string }[];
  readonly limits: Readonly<Record<string, number>>;
}

export interface BoardBlock {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly parentId?: string;
  readonly text?: string;
  /** Only for block types of this plugin. */
  readonly props?: Record<string, unknown>;
}

export interface BoardConnector {
  readonly id: string;
  readonly from: { blockId: string } | { x: number; y: number };
  readonly to: { blockId: string } | { x: number; y: number };
  readonly label?: string;
}

export interface BoardSnapshot {
  readonly board: { readonly id: string; readonly title: string };
  readonly blocks: BoardBlock[];
  readonly connectors: BoardConnector[];
}

export interface Events {
  'block.changed': { props?: Record<string, unknown>; width?: number; height?: number };
  'mode.changed': { mode: 'view' | 'edit' };
  'theme.changed': { theme: { colorScheme: 'light' | 'dark' } };
  destroy: Record<string, never>;
}

/** A request the board refused; switch on `code`, tolerate codes you do not know. */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

/** The parts of `window` the SDK uses (tests pass their own). */
export interface FrameWindow {
  readonly parent: unknown;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

export interface MessageEventLike {
  readonly source: unknown;
  readonly data: unknown;
  readonly ports: readonly MessagePort[];
}

export interface ConnectOptions {
  /** Default: the frame's `window`. */
  window?: FrameWindow;
  /** How long a request may take before it fails with TIMEOUT (default 15 s). */
  timeoutMs?: number;
}

export interface PluginContext {
  readonly init: InitPayload;
  /** The current props of the block (follows `block.changed`). */
  props(): Record<string, unknown>;
  size(): { width: number; height: number };
  mode(): 'view' | 'edit';
  /** True if the admin granted the capability (for import.register: with that media type). */
  can(capability: CapabilityName, value?: string): boolean;
  /** True if this user may change the block now (edit mode, editor or owner). */
  canEdit(): boolean;
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void;
  /** Tells the board the plugin has rendered: the frame becomes visible. */
  ready(): void;
  /** Replaces the props of this block (JSON values, at most 64 KiB). Needs `block.props`. */
  setProps(props: Record<string, Json>): Promise<void>;
  /** Needs `block.resize`; integers 16-4096. */
  resize(width: number, height: number): Promise<{ width: number; height: number }>;
  /** The whole board (all pages). Needs `board.read`. */
  readBoard(): Promise<BoardSnapshot>;
  /** Needs `ui.toast`; plain text, at most 200 characters. */
  toast(level: 'info' | 'success' | 'warning' | 'error', message: string): Promise<void>;
  /** Needs `ui.openLink`; the user confirms first. False when they declined. */
  openLink(url: string): Promise<boolean>;
  /** Needs `storage`: a key-value store of this plugin on this board (1 MB in total). */
  readonly storage: {
    get<T extends Json = Json>(key: string): Promise<T | null>;
    /** `null` deletes the key. */
    set(key: string, value: Json): Promise<void>;
    keys(): Promise<string[]>;
  };
}

/**
 * Waits for the board's connect message - the FIRST message from the parent window carrying a
 * port, every later window message is ignored - then for `init`. Resolves with the context.
 */
export function connect(options: ConnectOptions = {}): Promise<PluginContext> {
  const win = options.window ?? (globalThis as unknown as { window: FrameWindow }).window;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve) => {
    const onConnect = (event: MessageEventLike): void => {
      const data = event.data as { type?: unknown; v?: unknown } | null;
      if (
        event.source !== win.parent ||
        data?.type !== 'connect' ||
        data.v !== 1 ||
        event.ports.length !== 1
      ) {
        return; // not the board: ignore (a page cannot spoof the board's port)
      }
      win.removeEventListener('message', onConnect);
      const channel = new Channel(event.ports[0] as MessagePort, timeoutMs);
      channel.onInit = (init) => resolve(createContext(channel, init));
    };
    win.addEventListener('message', onConnect);
  });
}

/**
 * Connects, renders the block into `document.body` with `render` and tells the board it is
 * ready - the usual entry module of a block plugin.
 */
export async function defineBlock(
  render: (root: HTMLElement, ctx: PluginContext) => void | Promise<void>,
  options: ConnectOptions & { root?: HTMLElement } = {},
): Promise<PluginContext> {
  const ctx = await connect(options);
  await render(options.root ?? document.body, ctx);
  ctx.ready();
  return ctx;
}

interface Pending {
  resolve(payload: Record<string, unknown>): void;
  reject(error: PluginError): void;
  timer: ReturnType<typeof setTimeout>;
}

class Channel {
  onInit: ((init: InitPayload) => void) | undefined;
  readonly listeners = new Map<string, Set<(payload: never) => void>>();
  private readonly pending = new Map<string, Pending>();
  private next = 1;
  private initialised = false;

  constructor(
    private readonly port: MessagePort,
    private readonly timeoutMs: number,
  ) {
    port.onmessage = (event: MessageEvent) => this.receive(event.data);
    port.start?.();
  }

  request(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `p-${this.next++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new PluginError('TIMEOUT', `${type} got no answer`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.port.postMessage({ type, v: 1, requestId, payload });
    });
  }

  event(type: string, payload: Record<string, unknown>): void {
    this.port.postMessage({ type, v: 1, payload });
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null) {
      return;
    }
    const { type, requestId, payload } = data as {
      type?: string;
      requestId?: string;
      payload?: Record<string, unknown>;
    };
    if (typeof type !== 'string' || typeof payload !== 'object' || payload === null) {
      return;
    }
    if (requestId !== undefined) {
      const waiting = this.pending.get(requestId);
      if (!waiting) {
        return;
      }
      this.pending.delete(requestId);
      clearTimeout(waiting.timer);
      if (type === 'error') {
        waiting.reject(
          new PluginError(String(payload['code'] ?? 'UNKNOWN'), String(payload['message'] ?? '')),
        );
      } else {
        waiting.resolve(payload);
      }
      return;
    }
    if (type === 'init') {
      if (!this.initialised) {
        this.initialised = true;
        this.onInit?.(payload as unknown as InitPayload);
      }
      return;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      (listener as (p: unknown) => void)(payload);
    }
  }
}

function createContext(channel: Channel, init: InitPayload): PluginContext {
  let props: Record<string, unknown> = { ...(init.block?.props ?? {}) };
  let size = { width: init.block?.width ?? 0, height: init.block?.height ?? 0 };
  let mode = init.mode;
  const on = <K extends keyof Events>(event: K, listener: (payload: Events[K]) => void) => {
    const set = channel.listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    channel.listeners.set(event, set);
    return () => set.delete(listener as (payload: never) => void);
  };
  // keep the local view current before the plugin's own listeners run
  on('block.changed', (change) => {
    props = change.props ?? props;
    size = { width: change.width ?? size.width, height: change.height ?? size.height };
  });
  on('mode.changed', (change) => (mode = change.mode));

  const ctx: PluginContext = {
    init,
    props: () => props,
    size: () => size,
    mode: () => mode,
    can: (name, value) =>
      init.capabilities.some((c) => c.name === name && (value === undefined || c.value === value)),
    canEdit: () => mode === 'edit' && (init.role === 'EDITOR' || init.role === 'OWNER'),
    on,
    ready: () => channel.event('ready', {}),
    async setProps(next) {
      await channel.request('block.setProps', { props: next });
      props = next;
    },
    async resize(width, height) {
      const applied = (await channel.request('block.resize', { width, height })) as {
        width: number;
        height: number;
      };
      size = applied;
      return applied;
    },
    async readBoard() {
      const blocks: BoardBlock[] = [];
      let connectors: BoardConnector[] = [];
      let board: { id: string; title: string } | undefined;
      let cursor: string | undefined;
      do {
        const page = (await channel.request('board.read', cursor ? { cursor } : {})) as {
          board: { id: string; title: string };
          blocks: BoardBlock[];
          connectors: BoardConnector[];
          nextCursor?: string;
        };
        board = page.board;
        blocks.push(...page.blocks);
        connectors = cursor ? connectors : page.connectors;
        cursor = page.nextCursor;
      } while (cursor);
      return { board: board ?? { id: init.board.id, title: '' }, blocks, connectors };
    },
    async toast(level, message) {
      await channel.request('ui.toast', { level, message });
    },
    async openLink(url) {
      try {
        await channel.request('ui.openLink', { url });
        return true;
      } catch (error) {
        if (error instanceof PluginError && error.code === 'CANCELLED') {
          return false;
        }
        throw error;
      }
    },
    storage: {
      async get<T extends Json = Json>(key: string) {
        return ((await channel.request('storage.get', { key }))['value'] ?? null) as T | null;
      },
      async set(key, value) {
        await channel.request('storage.set', { key, value });
      },
      async keys() {
        return (await channel.request('storage.keys', {}))['keys'] as string[];
      },
    },
  };
  return ctx;
}
