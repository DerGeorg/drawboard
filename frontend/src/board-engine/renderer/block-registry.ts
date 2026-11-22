import {
  type BoardDoc,
  BlockData,
  Point,
  Props,
  Size,
  BoardTheme,
  Emitter,
} from '@apps/drawboard-engine';

/** What a block type's `render` gets: read access to its own block, nothing else. */
export interface BlockRenderContext {
  /** The block as it was when the view was created (use `update` for later states). */
  readonly block: BlockData;
  /** The plain content of the block's Y.Text ('' if it has none). */
  text(): string;
  readonly readOnly: boolean;
  /**
   * The theme the board is shown in now. Read it in `render` and `update`: a theme change calls
   * `update` on every mounted block (no document change). Colours of the content are mapped
   * with `displayColor`; the chrome uses the `--be-*` CSS variables.
   */
  theme(): BoardTheme;
  /**
   * Write access for TRUSTED built-in blocks (kanban, story card) that edit their own data in
   * place. Plugin blocks never see it: their views are sandboxed frames that only talk to the
   * plugin host (S3.1, S3.8).
   */
  readonly host?: BlockHost;
}

/** Something a block asks the app around the engine to do (open an editor for a part of it). */
export interface BlockRequest {
  readonly blockId: string;
  /** Namespaced by the block type, e.g. `kanban.card`. */
  readonly action: string;
  /** The part of the block the request is about (a card id). */
  readonly itemId?: string;
}

/** What the engine offers a trusted block view (see `BlockRenderContext.host`). */
export interface BlockHost {
  readonly board: BoardDoc;
  /** The board's read-only flag now (it can change while the block is mounted). */
  readOnly(): boolean;
  /** Called when the read-only flag changes; returns the unsubscribe function. */
  onReadOnlyChanged(listener: (readOnly: boolean) => void): () => void;
  /** Starts a new undo step (call before and after a discrete edit). */
  stopCapturing(): void;
  /** The world point under a viewport (client) position. */
  worldAtClient(clientX: number, clientY: number): Point;
  /** Replaces the selection. */
  select(ids: readonly string[]): void;
  /** Hands a request to the host app (`BoardEngine.blockRequested`). */
  request(request: BlockRequest): void;
}

export interface BlockView {
  /** Called whenever the block's geometry, props or text changed, and when the theme changed. */
  update(block: BlockData): void;
  /**
   * Called once the block's element is in the document (and again if it is mounted anew after
   * scrolling out of view). Only now sizes can be measured; `render` runs on a detached element.
   */
  mounted?(): void;
  destroy(): void;
}

/**
 * A block type. Built-in blocks register through this exactly like a plugin block will
 * (architecture 3.8): the engine never special-cases a type.
 */
export interface BlockType {
  /** Namespaced id, e.g. `core.sticky`, `acme.timer`. */
  readonly type: string;
  readonly label: string;
  readonly defaultSize: Size;
  readonly defaultProps: Props;
  /** True if the block has a Y.Text the user edits by double-click. */
  readonly textEditable?: boolean;
  /**
   * The editor's limit for that text (default 100 000). A smaller limit also makes the editor
   * one line: Enter ends editing (frame titles). The view may mark the element the editor opens
   * in with `data-be-text-host` (default: the whole block).
   */
  readonly textMaxLength?: number;
  /**
   * True if a double-click asks the host to open an editor of its own for the block (the
   * engine emits `blockOpened`), e.g. the source panel of a diagram.
   */
  readonly opensEditor?: boolean;
  /**
   * True only for the built-in types (set in `registerBuiltinBlocks` and nowhere else): the
   * renderer hands `BlockRenderContext.host` to trusted types alone (M4 review SHOULD 1).
   * Plugin types (`PluginHost.blockType`) never carry it.
   */
  readonly trusted?: true;
  /**
   * The colour of the block far zoomed out (below `SIMPLE_ZOOM` every block is a plain box, see
   * `renderer/simple-view.ts`). Read only for trusted types and passed through `safeColor`;
   * without it the box is neutral grey.
   */
  readonly simpleFill?: (block: BlockData) => string;
  /** Fills `host` (an absolutely positioned element sized to the block) and returns the view. */
  render(host: HTMLElement, ctx: BlockRenderContext): BlockView;
}

export class BlockTypeRegistry {
  private readonly types = new Map<string, BlockType>();
  /** Types registered or removed after the start (plugins): mounted blocks of them re-render. */
  readonly changed = new Emitter<ReadonlySet<string>>();

  register(type: BlockType): void {
    if (this.types.has(type.type)) {
      throw new Error(`Block type already registered: ${type.type}`);
    }
    this.types.set(type.type, type);
  }

  /** Registers several types at once (all or none) and tells the renderer. */
  registerAll(types: readonly BlockType[]): void {
    const names = new Set(types.map((t) => t.type));
    if (names.size !== types.length || types.some((t) => this.types.has(t.type))) {
      throw new Error('Block type already registered');
    }
    for (const t of types) {
      this.types.set(t.type, t);
    }
    this.changed.emit(names);
  }

  /** Removes types (a plugin was disabled): their blocks become placeholders, data kept. */
  unregisterAll(names: readonly string[]): void {
    const removed = new Set(names.filter((n) => this.types.delete(n)));
    if (removed.size > 0) {
      this.changed.emit(removed);
    }
  }

  get(type: string): BlockType | undefined {
    return this.types.get(type);
  }

  list(): BlockType[] {
    return Array.from(this.types.values());
  }
}
