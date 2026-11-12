import { BoardDoc } from '../model/board-doc';
import { BlockData, isBlockEnd } from '../model/types';
import { BlockType, BlockTypeRegistry, BlockView } from '../renderer/block-registry';
import { Emitter } from '../util/emitter';
import { EndReason, FrameConnector, PluginInstance, defaultConnector } from './plugin-instance';
import {
  CAPABILITIES,
  Capability,
  CapabilityName,
  LIMITS,
  PLUGIN_ID,
  PluginError,
  isPlainJson,
  jsonBytes,
} from './protocol';

/** An enabled plugin as `listEnabledPlugins` returns it (contract `EnabledPlugin`). */
export interface EnabledPluginInfo {
  readonly id: string;
  readonly version: string;
  readonly assetBase: string;
  readonly entry: string;
  readonly integrity: string;
  readonly blockTypes: readonly {
    readonly type: string;
    readonly label: string;
    readonly defaultWidth: number;
    readonly defaultHeight: number;
  }[];
  readonly grantedCapabilities: readonly { readonly name: string; readonly value?: string }[];
  readonly userPseudonym: string;
}

/** A plugin that passed `validatePlugin`. */
export interface ValidPlugin extends EnabledPluginInfo {
  readonly grantedCapabilities: readonly Capability[];
  /**
   * The block types this plugin owns: exactly its declared `blockTypes`. Ownership is
   * membership in this set, never a string prefix (S3.8).
   */
  readonly own: ReadonlySet<string>;
}

export type BoardRoleName = 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER';

/** Who looks at which board: what `init` tells a plugin (no user id, no email, S3.8). */
export interface PluginSession {
  readonly boardId: string;
  boardTitle(): string;
  role(): BoardRoleName;
  userName(): string;
  guest(): boolean;
  readonly locale: string;
  colorScheme(): 'light' | 'dark';
}

/**
 * What the host needs from the app: the storage API (with the user's token - the frame never
 * calls the API itself), toasts, and asking the user before a link opens. Storage failures are
 * PluginErrors (CONFLICT, TOO_LARGE, NOT_ALLOWED, TOO_MANY_REQUESTS, UNAVAILABLE).
 */
export interface PluginServices {
  getStorage(pluginId: string): Promise<{ data: Record<string, unknown>; version: number }>;
  putStorage(pluginId: string, data: Record<string, unknown>, version: number): Promise<void>;
  toast(pluginId: string, level: 'info' | 'success' | 'warning' | 'error', message: string): void;
  /** Shows the target host and asks; true = open. */
  confirmLink(pluginId: string, url: URL): Promise<boolean>;
  /** Opens with noopener/noreferrer in a new tab. */
  openLink(url: string): void;
}

/** The engine as the plugin host sees it. */
export interface PluginBoard {
  readonly board: BoardDoc;
  readonly registry: BlockTypeRegistry;
  readonly readOnly: boolean;
  readonly readOnlyChanged: Emitter<boolean>;
}

export interface PluginHostOptions {
  /** `DRAWBOARD_PLUGIN_ORIGIN` from the runtime config; frames come from nowhere else. */
  pluginOrigin?: string;
  /** Hands the port to the frame (default: postMessage to the frame's window). */
  connect?: FrameConnector;
  /** Whether the block element is on screen (default: IntersectionObserver). */
  observe?: (el: HTMLElement, onChange: (visible: boolean) => void) => () => void;
  maxFrames?: number;
}

/** What instances use to act on the board; one per host. */
export interface PluginRuntime {
  readonly board: BoardDoc;
  readonly session: PluginSession;
  readonly connect: FrameConnector;
  mode(): 'view' | 'edit';
  execute(
    plugin: ValidPlugin,
    blockId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

const ASSET_PATH = /^\/plugin-assets\/([a-z0-9.-]+)\/([0-9A-Za-z.+-]{1,64})\/[0-9a-f]{64}\/$/;
const PSEUDONYM = /^[A-Za-z0-9_-]{43}$/;
const RESERVED = /^(core|drawboard)\./;

/**
 * Checks an enabled plugin before anything of it is used (S3.1, S3.5): id, block types in its
 * namespace and outside the reserved ones, asset base exactly `/plugin-assets/<id>/<version>/
 * <sha256>/` on the app origin or on the plugin origin, known capabilities, a pseudonym. A
 * plugin is never trusted: whatever else the object says is ignored. Returns undefined to drop it.
 * `own` is the set of its declared block types (each of them in its namespace).
 */
export function validatePlugin(
  p: EnabledPluginInfo,
  pluginOrigin: string | undefined,
): ValidPlugin | undefined {
  if (!PLUGIN_ID.test(p.id) || p.id.length > 100 || RESERVED.test(`${p.id}.`)) {
    return undefined;
  }
  const base =
    pluginOrigin && p.assetBase.startsWith(`${pluginOrigin}/`)
      ? p.assetBase.slice(pluginOrigin.length)
      : p.assetBase;
  const match = ASSET_PATH.exec(base);
  if (!match || match[1] !== p.id || match[2] !== p.version) {
    return undefined;
  }
  if (base === p.assetBase && pluginOrigin) {
    return undefined; // with a plugin origin every frame comes from it, never from the app origin
  }
  if (!PSEUDONYM.test(p.userPseudonym)) {
    return undefined;
  }
  const types = p.blockTypes.filter(
    (t) =>
      t.type.startsWith(`${p.id}.`) &&
      PLUGIN_ID.test(t.type) &&
      t.type.length <= 150 &&
      Number.isInteger(t.defaultWidth) &&
      Number.isInteger(t.defaultHeight) &&
      t.defaultWidth >= 16 &&
      t.defaultWidth <= 4096 &&
      t.defaultHeight >= 16 &&
      t.defaultHeight <= 4096,
  );
  const own = new Set(types.map((t) => t.type));
  if (types.length !== p.blockTypes.length || own.size !== types.length) {
    return undefined;
  }
  const capabilities = p.grantedCapabilities.filter((c): c is Capability =>
    CAPABILITIES.includes(c.name as CapabilityName),
  );
  return {
    id: p.id,
    version: p.version,
    assetBase: p.assetBase,
    entry: p.entry,
    integrity: p.integrity,
    blockTypes: types.map((t) => ({ ...t, label: String(t.label).slice(0, 100) })),
    grantedCapabilities: capabilities.map((c) => ({ name: c.name, value: c.value })),
    userPseudonym: p.userPseudonym,
    own,
  };
}

/** A block type of a plugin as the toolbar offers it. */
export interface PluginBlockOption {
  readonly pluginId: string;
  readonly type: string;
  readonly label: string;
  readonly w: number;
  readonly h: number;
}

/**
 * Runs the plugins of one open board (architecture 3.8, S3): registers their block types as
 * sandboxed iframe blocks (never in the page, S3.1), keeps at most 50 frames alive and only for
 * blocks on screen (S3.2), executes the capability requests of the frames (S3.8), and removes
 * every frame of a plugin at once when it is disabled or removed (S3.10).
 */
export class PluginHost implements PluginRuntime {
  readonly board: BoardDoc;
  readonly connect: FrameConnector;
  /** The block types of the enabled plugins, for the toolbar. */
  readonly blockOptionsChanged = new Emitter<PluginBlockOption[]>();

  /** Plugins dropped by the last `setPlugins`: invalid, clashing in id or block type, refused. */
  droppedPlugins = 0;

  private plugins = new Map<string, ValidPlugin>();
  private readonly stopped = new Set<string>();
  private readonly views = new Set<PluginBlockView>();
  private readonly waiting: PluginBlockView[] = [];
  private live = 0;
  private readonly maxFrames: number;
  private readonly storageQueues = new Map<string, Promise<unknown>>();
  private readonly offReadOnly: () => void;

  constructor(
    private readonly target: PluginBoard,
    readonly session: PluginSession,
    private readonly services: PluginServices,
    private readonly options: PluginHostOptions = {},
  ) {
    this.board = target.board;
    this.connect = options.connect ?? defaultConnector;
    this.maxFrames = options.maxFrames ?? LIMITS.framesPerBoard;
    this.offReadOnly = target.readOnlyChanged.on(() => {
      for (const view of this.views) {
        view.instance?.modeChanged();
      }
    });
  }

  mode(): 'view' | 'edit' {
    return this.target.readOnly ? 'view' : 'edit';
  }

  get frameCount(): number {
    return this.live;
  }

  /**
   * The enabled plugins as the server lists them now. New ones are registered, removed or
   * disabled ones lose every frame at once and their blocks become placeholders that keep the
   * data (S3.10); a changed version or grant set re-registers the plugin.
   */
  setPlugins(list: readonly EnabledPluginInfo[]): void {
    const next = new Map<string, ValidPlugin>();
    const claimed = new Set<string>();
    let dropped = 0;
    for (const raw of list) {
      const valid = validatePlugin(raw, this.options.pluginOrigin);
      // a plugin that navigated itself stays as it is: never started anew, never replaced
      const plugin = valid && this.stopped.has(valid.id) ? this.plugins.get(valid.id) : valid;
      if (!plugin) {
        if (!valid) {
          dropped++;
        }
        continue;
      }
      // first in list order wins: an id equal to, a dot-prefix of or an extension of an accepted
      // id, or a block type an accepted plugin already declares, drops the later plugin (S3.8)
      const clash =
        [...next.keys()].some(
          (id) =>
            id === plugin.id || id.startsWith(`${plugin.id}.`) || plugin.id.startsWith(`${id}.`),
        ) || [...plugin.own].some((t) => claimed.has(t));
      if (clash) {
        dropped++;
        continue;
      }
      next.set(plugin.id, plugin);
      plugin.own.forEach((t) => claimed.add(t));
    }
    this.droppedPlugins = dropped;
    for (const [id, old] of [...this.plugins]) {
      const now = next.get(id);
      if (!now || JSON.stringify(now) !== JSON.stringify(old)) {
        this.remove(old);
        this.plugins.delete(id);
      }
    }
    for (const plugin of next.values()) {
      if (!this.plugins.has(plugin.id)) {
        try {
          this.add(plugin);
        } catch {
          this.droppedPlugins++; // the registry refused it: the rest of the list still loads
        }
      }
    }
    this.blockOptionsChanged.emit(this.blockOptions());
  }

  /** Whether a frame of this plugin navigated itself: the plugin is off for this session. */
  isStopped(pluginId: string): boolean {
    return this.stopped.has(pluginId);
  }

  /**
   * A frame of the plugin navigated itself: it could send what it knows anywhere, so no frame
   * of this plugin runs on this board for the session (S3.8). Its blocks keep their data.
   */
  stopPlugin(pluginId: string): void {
    if (this.stopped.has(pluginId)) {
      return;
    }
    this.stopped.add(pluginId);
    for (const view of [...this.views]) {
      if (view.plugin.id === pluginId) {
        view.end('navigated');
      }
    }
  }

  blockOptions(): PluginBlockOption[] {
    return [...this.plugins.values()].flatMap((p) =>
      p.blockTypes.map((t) => ({
        pluginId: p.id,
        type: t.type,
        label: t.label,
        w: t.defaultWidth,
        h: t.defaultHeight,
      })),
    );
  }

  destroy(): void {
    for (const plugin of this.plugins.values()) {
      this.remove(plugin);
    }
    this.plugins.clear();
    this.stopped.clear();
    this.offReadOnly();
    this.blockOptionsChanged.clear();
  }

  private add(plugin: ValidPlugin): void {
    const types = plugin.blockTypes.map((t) => this.blockType(plugin, t));
    this.target.registry.registerAll(types); // all or none; a throw leaves nothing registered
    this.plugins.set(plugin.id, plugin);
  }

  private remove(plugin: ValidPlugin): void {
    for (const view of [...this.views]) {
      if (view.plugin.id === plugin.id) {
        view.end('disabled');
      }
    }
    this.target.registry.unregisterAll(plugin.blockTypes.map((t) => t.type));
  }

  private blockType(plugin: ValidPlugin, t: EnabledPluginInfo['blockTypes'][number]): BlockType {
    return {
      type: t.type,
      label: t.label,
      defaultSize: { w: t.defaultWidth, h: t.defaultHeight },
      defaultProps: {},
      render: (host, ctx) => {
        const view = new PluginBlockView(this, plugin, host, ctx.block, this.options.observe);
        this.views.add(view);
        return view;
      },
    };
  }

  // ---- frame budget (S3.2) -------------------------------------------------------------------

  /** A view on screen wants a frame; it waits while 50 are alive. */
  acquire(view: PluginBlockView): boolean {
    if (this.live < this.maxFrames) {
      this.live++;
      return true;
    }
    if (!this.waiting.includes(view)) {
      this.waiting.push(view);
    }
    return false;
  }

  release(view: PluginBlockView, hadFrame: boolean): void {
    const i = this.waiting.indexOf(view);
    if (i >= 0) {
      this.waiting.splice(i, 1);
    }
    if (hadFrame) {
      this.live--;
      this.waiting.shift()?.retry();
    }
  }

  forget(view: PluginBlockView): void {
    this.views.delete(view);
  }

  // ---- capabilities (S3.8) -------------------------------------------------------------------

  async execute(
    plugin: ValidPlugin,
    blockId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (type) {
      case 'block.setProps':
        return this.setProps(plugin, blockId, payload['props'] as Record<string, unknown>);
      case 'block.resize':
        return this.resize(plugin, blockId, payload as { width: number; height: number });
      case 'board.read':
        return this.read(plugin, payload['cursor'] as string | undefined);
      case 'export.register':
      case 'import.register':
        // formats are registered by a service instance; plugin API 1 in M3 runs block
        // instances only, so these requests have no place to land
        throw new PluginError('NOT_ALLOWED', 'not a service instance');
      case 'ui.toast':
        this.services.toast(plugin.id, payload['level'] as 'info', payload['message'] as string);
        return {};
      case 'ui.openLink':
        return this.openLink(plugin, payload['url'] as URL);
      case 'storage.get':
        return { value: ownValue((await this.storage(plugin)).data, payload['key'] as string) };
      case 'storage.keys':
        return { keys: Object.keys((await this.storage(plugin)).data) };
      case 'storage.set':
        return this.storageSet(plugin, payload['key'] as string, payload['value']);
      default:
        throw new PluginError('NOT_FOUND', 'unknown request');
    }
  }

  private requireEdit(plugin: ValidPlugin, blockId: string): BlockData {
    const block = this.board.getBlock(blockId);
    if (!block) {
      throw new PluginError('NOT_FOUND', 'the block is gone');
    }
    if (!plugin.own.has(block.type)) {
      throw new PluginError('NOT_ALLOWED', 'a block type of another plugin');
    }
    const role = this.session.role();
    if (this.mode() !== 'edit' || (role !== 'EDITOR' && role !== 'OWNER')) {
      throw new PluginError('NOT_ALLOWED', 'the board is in view mode for this user');
    }
    return block;
  }

  private setProps(
    plugin: ValidPlugin,
    blockId: string,
    props: Record<string, unknown>,
  ): Record<string, unknown> {
    this.requireEdit(plugin, blockId);
    // isPlainJson also refuses __proto__, constructor and prototype as member names at any depth
    if (!isPlainJson(props)) {
      throw new PluginError('INVALID_PAYLOAD', 'props must be JSON values');
    }
    if (jsonBytes(props) > LIMITS.propsBytes) {
      throw new PluginError('TOO_LARGE', 'props are larger than 64 KiB');
    }
    this.board.replaceProps(blockId, props);
    return {};
  }

  private resize(
    plugin: ValidPlugin,
    blockId: string,
    size: { width: number; height: number },
  ): Record<string, unknown> {
    this.requireEdit(plugin, blockId);
    this.board.setGeometry(blockId, { w: size.width, h: size.height });
    const block = this.board.getBlock(blockId);
    return { width: block?.w ?? size.width, height: block?.h ?? size.height };
  }

  /** Structure and text of this board, 500 blocks a page, props only of the plugin's own types. */
  private read(plugin: ValidPlugin, cursor: string | undefined): Record<string, unknown> {
    const start = cursor ? Number(cursor) : 0;
    const all = this.board.blocks();
    const page = all.slice(start, start + LIMITS.boardReadPage).map((b) => ({
      id: b.id,
      type: b.type,
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
      rotation: b.rotation,
      ...(b.parent ? { parentId: b.parent } : {}),
      ...(b.hasText ? { text: this.board.textOf(b.id) } : {}),
      ...(plugin.own.has(b.type) ? { props: b.props } : {}),
    }));
    const end = start + LIMITS.boardReadPage;
    return {
      board: { id: this.session.boardId, title: this.session.boardTitle() },
      blocks: page,
      // connectors come with the first page
      connectors:
        start === 0
          ? this.board.connectors().map((c) => ({
              id: c.id,
              from: isBlockEnd(c.from) ? { blockId: c.from.block } : { x: c.from.x, y: c.from.y },
              to: isBlockEnd(c.to) ? { blockId: c.to.block } : { x: c.to.x, y: c.to.y },
              ...(c.label ? { label: c.label } : {}),
            }))
          : [],
      ...(end < all.length ? { nextCursor: String(end) } : {}),
    };
  }

  private async openLink(plugin: ValidPlugin, url: URL): Promise<Record<string, unknown>> {
    if (!(await this.services.confirmLink(plugin.id, url))) {
      throw new PluginError('CANCELLED', 'the user declined');
    }
    this.services.openLink(url.href);
    return { opened: true };
  }

  private storage(
    plugin: ValidPlugin,
  ): Promise<{ data: Record<string, unknown>; version: number }> {
    return this.services.getStorage(plugin.id);
  }

  /** Read-modify-write with the object's version; a 409 is retried up to 3 times. */
  private storageSet(
    plugin: ValidPlugin,
    key: string,
    value: unknown,
  ): Promise<Record<string, unknown>> {
    const role = this.session.role();
    if (this.session.guest() || (role !== 'EDITOR' && role !== 'OWNER')) {
      return Promise.reject(new PluginError('NOT_ALLOWED', 'this user may not write the storage'));
    }
    if (!isPlainJson(value)) {
      return Promise.reject(new PluginError('INVALID_PAYLOAD', 'value must be a JSON value'));
    }
    if (jsonBytes(value) > LIMITS.storageValueBytes) {
      return Promise.reject(new PluginError('TOO_LARGE', 'value is larger than 200 KiB'));
    }
    // one write per plugin at a time: concurrent writes of its own frames do not conflict
    const previous = this.storageQueues.get(plugin.id) ?? Promise.resolve();
    const run = previous.then(
      () => this.writeStorage(plugin, key, value),
      () => this.writeStorage(plugin, key, value),
    );
    this.storageQueues.set(
      plugin.id,
      run.catch(() => undefined),
    );
    return run;
  }

  private async writeStorage(
    plugin: ValidPlugin,
    key: string,
    value: unknown,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt <= LIMITS.storageRetries; attempt++) {
      const { data, version } = await this.services.getStorage(plugin.id);
      const next: Record<string, unknown> = { ...data };
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
      if (jsonBytes(next) > LIMITS.storageBytes) {
        throw new PluginError('TOO_LARGE', 'the storage of this plugin would exceed 1 MB');
      }
      try {
        await this.services.putStorage(plugin.id, next, version);
        return {};
      } catch (error) {
        if (!(error instanceof PluginError) || error.code !== 'CONFLICT') {
          throw error;
        }
      }
    }
    throw new PluginError('CONFLICT', 'the storage changed concurrently');
  }
}

/** A stored value by own key only: `constructor` and the like are not inherited answers. */
function ownValue(data: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(data, key) ? (data[key] ?? null) : null;
}

const PLACEHOLDER: Record<EndReason | 'waiting', string> = {
  waiting: 'Paused: too many plugin blocks are visible at once.',
  'not-started': 'The plugin did not start.',
  terminated: 'The plugin was stopped. Reload the board to start it again.',
  navigated:
    'The plugin was stopped on this board because one of its frames navigated itself. Reload the board to start it again.',
  disabled: 'This plugin is not available.',
  destroyed: '',
};

/**
 * The view of a plugin block: a frame with a badge "Plugin: <id>" (S3.11; also the handle to
 * drag the block), the iframe only while the block is on screen and a frame slot is free.
 */
export class PluginBlockView implements BlockView {
  instance: PluginInstance | undefined;
  private readonly root: HTMLElement;
  private readonly slot: HTMLElement;
  private readonly stopObserving: () => void;
  private visible = false;
  private hasFrame = false;
  private block: BlockData;
  private stopped: EndReason | undefined;

  constructor(
    private readonly host: PluginHost,
    readonly plugin: ValidPlugin,
    element: HTMLElement,
    block: BlockData,
    observe: PluginHostOptions['observe'] = observeVisibility,
  ) {
    this.block = block;
    const d = element.ownerDocument;
    this.root = d.createElement('div');
    this.root.className = 'be-plugin';
    this.root.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;' +
      'border:1px dashed #7c3aed;border-radius:6px;background:#fff;overflow:hidden';
    const badge = d.createElement('div');
    badge.className = 'be-plugin-badge';
    badge.style.cssText =
      'flex:0 0 18px;font:11px system-ui,sans-serif;color:#5b21b6;background:#f5f3ff;padding:2px 6px;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:move';
    badge.textContent = `Plugin: ${plugin.id}`;
    this.slot = d.createElement('div');
    this.slot.className = 'be-plugin-slot';
    this.slot.style.cssText =
      'flex:1 1 auto;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;' +
      'font:12px system-ui,sans-serif;color:#64748b;text-align:center';
    this.root.append(badge, this.slot);
    element.appendChild(this.root);
    this.stopObserving = observe(element, (visible) => {
      this.visible = visible;
      if (visible) {
        this.retry();
      } else {
        this.dropFrame();
      }
    });
  }

  update(block: BlockData): void {
    this.block = block;
    this.instance?.blockChanged(block);
  }

  destroy(): void {
    this.stopObserving();
    this.dropFrame();
    this.host.release(this, false);
    this.host.forget(this);
    this.root.remove();
  }

  /** Ends the frame for good (plugin disabled, stopped, not started) and shows why. */
  end(reason: EndReason): void {
    if (this.stopped === 'navigated') {
      return; // the plugin was stopped; "disabled" or "destroyed" must not hide that
    }
    this.stopped = reason;
    if (this.instance) {
      this.instance.end(reason);
    } else {
      this.host.release(this, false);
      this.show(reason);
    }
  }

  /** Gets a frame if the block is on screen and a slot is free. */
  retry(): void {
    if (!this.visible || this.instance || this.stopped) {
      return;
    }
    if (this.host.isStopped(this.plugin.id)) {
      this.end('navigated'); // a re-mount or a new block of a stopped plugin starts no frame
      return;
    }
    if (!this.host.acquire(this)) {
      this.show('waiting');
      return;
    }
    this.hasFrame = true;
    this.instance = new PluginInstance(this.plugin, this.host, this.block.id, this.slot, (r) =>
      this.ended(r),
    );
  }

  private dropFrame(): void {
    this.instance?.end('destroyed');
  }

  private ended(reason: EndReason): void {
    this.instance = undefined;
    if (this.hasFrame) {
      this.hasFrame = false;
      this.host.release(this, true);
    }
    if (reason !== 'destroyed') {
      this.stopped = reason;
    }
    this.show(reason);
    if (reason === 'navigated') {
      this.host.stopPlugin(this.plugin.id);
    }
  }

  private show(reason: EndReason | 'waiting'): void {
    const p = this.slot.ownerDocument.createElement('div');
    p.className = `be-plugin-${reason}`;
    p.style.padding = '8px';
    p.textContent = PLACEHOLDER[reason];
    this.slot.replaceChildren(p);
  }
}

/** On screen = intersecting the viewport; without IntersectionObserver (tests) always. */
function observeVisibility(el: HTMLElement, onChange: (visible: boolean) => void): () => void {
  const IO = el.ownerDocument.defaultView?.IntersectionObserver;
  if (!IO) {
    onChange(true);
    return () => undefined;
  }
  const observer = new IO((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) {
      onChange(entry.isIntersecting);
    }
  });
  observer.observe(el);
  return () => observer.disconnect();
}
