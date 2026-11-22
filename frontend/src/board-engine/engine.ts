import {
  Camera,
  INITIAL_CAMERA,
  clampZoom,
  fitToRect,
  glideCamera,
  panBy,
  screenToWorld,
  setZoomAt,
  zoomAt,
  SHAPE_TYPE,
  STICKY_COLORS,
  STICKY_TYPE,
  TEXT_TYPE,
  ImportError,
  ClipboardContent,
  PASTE_OFFSET,
  PasteResult,
  copyToClipboard,
  parseClipboard,
  pasteClipboard,
  BoardDoc,
  MAX_TEXT_LENGTH,
  Point,
  Rect,
  Size,
  LocalPresence,
  PeerPresence,
  applyTextDiff,
  FRAME_TYPE,
  FrameTree,
  assignParents,
  isFrame,
  removeFramesKeepContents,
  addColumn,
  addRow,
  cellOf,
  removeColumn,
  removeRow,
  tableOf,
  BoardTheme,
  Emitter,
  unionRects,
} from '@apps/drawboard-engine';
import { BuiltinServices, registerBuiltinBlocks } from './blocks/builtin';
import { EstimateSource } from './blocks/story';
import { InputController, InputTarget } from './input/input-controller';
import { KeyInfo, PointerInfo, WheelInfo } from './input/events';
import { BlockHost, BlockRequest, BlockTypeRegistry } from './renderer/block-registry';
import { HANDLE_SIZE, Overlay } from './renderer/overlay';
import { Renderer } from './renderer/renderer';
import { blockAt, hitTest, itemBounds } from './scene';
import { SelectionState } from './selection';
import { startTextEditor, TextEditSession } from './text/text-editor';
import { HandTool } from './tools/hand-tool';
import { deleteWithContents, duplicateWithContents } from './tools/select-tool';
import { READ_ONLY_TOOLS, TOOL_SHORTCUTS, createTools } from './tools';
import { HANDLES, handlePosition } from './tools/resize';
import { HandleId, HitResult, OverlayHints, Tool, ToolContext, ToolId } from './tools/tool';
import { History, HistoryState } from './undo';

/**
 * Where the current selection is on screen (CSS pixels relative to the container): the anchor
 * for a floating toolbar. `null` when there is nothing to anchor to - no selection, a read-only
 * board, a text edit or a drag of the selection in progress.
 */
export type SelectionAnchor = Rect | null;

export interface EngineOptions {
  readOnly?: boolean;
  /** The theme to start in (default light); change it later with `setTheme`. */
  theme?: BoardTheme;
  /** Registry with the block types; built-ins are registered if omitted. */
  registry?: BlockTypeRegistry;
  /** Host services of the built-in blocks (files); used when `registry` is omitted. */
  services?: BuiltinServices;
  /**
   * Id of the board on the server (null for a board that has none, e.g. one opened from a data
   * URL). Copies carry it, so file blocks are pasted only into the board they belong to.
   */
  boardId?: string | null;
}

/** See `BoardEngine.selectedTable`. */
export interface SelectedTable {
  id: string;
  rows: number;
  cols: number;
  /** Set when a cell is selected. */
  row?: number;
  col?: number;
}

/** What paste gets from the clipboard (ClipboardEvent data, already read). */
export interface PasteData {
  /** Content under CLIPBOARD_MIME (untrusted). */
  json?: string;
  /** `text/plain` (untrusted). */
  text?: string;
}

/** Style fields the style panel can change; which ones apply depends on the selected items. */
export interface StylePatch {
  /** Sticky note color, text color. */
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/** What the selection consists of; decides which style controls make sense. */
export type SelectionKind =
  'none' | 'sticky' | 'text' | 'shape' | 'frame' | 'stroke' | 'connector' | 'other' | 'mixed';

export type StyleInfo = Partial<Record<keyof StylePatch, string | number>>;

const ZOOM_STEP = 1.25;
const HIT_TOLERANCE = 6;
const HANDLE_HIT = HANDLE_SIZE + 4;

/**
 * The board editor without a framework: owns the DOM layers, turns DOM events into normalized
 * input for the active tool, and exposes callbacks for the host (Angular) and the collab
 * provider. `container` must be an empty element with a size.
 */
export class BoardEngine implements InputTarget, ToolContext {
  readonly registry: BlockTypeRegistry;
  readonly selection = new SelectionState();
  readonly drawStyle = {
    color: '#0f172a',
    size: 4,
    fill: '#ffffff',
    sticky: STICKY_COLORS[0] as string,
    emoji: '👍',
  };

  readonly toolChanged = new Emitter<ToolId>();
  readonly cameraChanged = new Emitter<Camera>();
  /** The visible area changed size (the container was resized). */
  readonly viewportResized = new Emitter<Size>();
  /**
   * The user moved the view themselves - wheel, pinch, hand tool, space or middle-button drag,
   * zoom buttons and shortcuts, fit. Not fired by `glideTo` (following someone).
   */
  readonly navigated = new Emitter<void>();
  readonly drawStyleChanged = new Emitter<void>();
  /** Fires when the style of something selected changed (by anyone) - the style panel re-reads. */
  readonly selectionStyleChanged = new Emitter<void>();
  /** Fires with the cursor and selection this client wants to share. */
  readonly localPresence = new Emitter<LocalPresence>();
  /**
   * Fires (once per frame at most, and only on a real change) with the selection's bounds in
   * screen coordinates; it follows panning, zooming, resizing of the container and edits by
   * anyone, and is `null` while the selection is being dragged or edited.
   */
  readonly selectionAnchorChanged = new Emitter<SelectionAnchor>();
  /**
   * Fires with the screen rectangle of the block whose text is being edited, and with `null`
   * when no text is edited; it follows panning and zooming. The emoji button of a text edit
   * sits at this rectangle.
   */
  readonly textEditAnchorChanged = new Emitter<SelectionAnchor>();
  /** The read-only flag changed (plugins switch between view and edit mode). */
  readonly readOnlyChanged = new Emitter<boolean>();
  /** The board is shown in another theme (`setTheme`); the document did not change. */
  readonly themeChanged = new Emitter<BoardTheme>();
  /** A block whose type has an editor of its own was double-clicked (id of the block). */
  readonly blockOpened = new Emitter<string>();
  /** A trusted block asks the host app for something (open a kanban card, ...). */
  readonly blockRequested = new Emitter<BlockRequest>();
  /**
   * Something the user should know after copy, paste or a big delete (too large, left out,
   * refused, "N items deleted").
   */
  readonly clipboardNotice = new Emitter<string>();

  private readonly renderer: Renderer;
  private readonly history: History;
  private readonly input: InputController;
  private readonly tools: Map<ToolId, Tool>;
  private readonly hand: HandTool;
  private readonly resizeObserver: ResizeObserver | undefined;
  private readonly unsubscribe: (() => void)[] = [];

  private activeTool: Tool;
  private _readOnly: boolean;
  private _camera: Camera = { ...INITIAL_CAMERA };
  private viewport: Size = { w: 0, h: 0 };
  private hints: OverlayHints = {};
  private peers: PeerPresence[] = [];
  private spaceHeld = false;
  private panning = false;
  private cameraDirty = false;
  private scheduled = false;
  private edit: TextEditSession | undefined;
  private lastCursor: Point | null = null;
  /** True between pointer down and up of a tool gesture (not of panning). */
  private gesture = false;
  private lastAnchor: SelectionAnchor = null;
  private lastEditAnchor: SelectionAnchor = null;
  private readonly boardId: string | null;
  private readonly estimateSource: EstimateSource | undefined;
  /** The previous paste: the same content at the same spot steps by PASTE_OFFSET. */
  private lastPaste: { key: string; at: Point; count: number } | undefined;
  private glideTarget: Camera | undefined;
  private glideFrame: number | undefined;

  constructor(
    private readonly container: HTMLElement,
    readonly board: BoardDoc,
    options: EngineOptions = {},
  ) {
    this._readOnly = options.readOnly ?? false;
    this.boardId = options.boardId ?? null;
    this.estimateSource = options.services?.estimates;
    this.registry =
      options.registry ?? registerBuiltinBlocks(new BlockTypeRegistry(), options.services);
    container.style.cssText +=
      ';position:relative;overflow:hidden;touch-action:none;user-select:none;outline:none';
    container.tabIndex = 0;

    const blockHost: BlockHost = {
      board,
      readOnly: () => this._readOnly,
      onReadOnlyChanged: (listener) => this.readOnlyChanged.on(listener),
      stopCapturing: () => this.history.stopCapturing(),
      worldAtClient: (x, y) => this.worldAtClient(x, y),
      select: (ids) => this.selection.set([...ids]),
      request: (request) => this.blockRequested.emit(request),
    };
    this.renderer = new Renderer(
      container,
      board,
      this.registry,
      () => this._readOnly,
      blockHost,
      options.theme ?? 'light',
    );
    this.history = new History(board);
    this.tools = createTools(this);
    this.hand = new HandTool(this);
    this.activeTool = this.tools.get('select') as Tool;
    this.input = new InputController(container, this, (p) => screenToWorld(this._camera, p));

    this.unsubscribe.push(
      board.observe((change) => {
        this.renderer.applyChange(change);
        this.selection.prune(
          (id) => board.hasBlock(id) || !!board.getConnector(id) || !!board.getStroke(id),
        );
        if (this.edit && !board.hasBlock(this.edit.blockId)) {
          this.edit.stop();
        }
        if (
          this.selection
            .list()
            .some(
              (id) => change.blocks.has(id) || change.strokes.has(id) || change.connectors.has(id),
            )
        ) {
          this.selectionStyleChanged.emit();
        }
        this.requestRender();
      }),
      this.selection.changed.on(() => {
        this.selectionStyleChanged.emit();
        this.localPresence.emit({ cursor: this.lastCursor, selection: this.selection.list() });
        this.requestRender();
      }),
    );
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(container);
    }
    this.measure();
    this.renderer.renderAll();
    this.applyCursor();
    this.flush();
  }

  // ---- ToolContext ---------------------------------------------------------------------------

  get camera(): Camera {
    return this._camera;
  }

  get readOnly(): boolean {
    return this._readOnly;
  }

  get estimates(): EstimateSource | undefined {
    return this.estimateSource;
  }

  clientAt(screen: Point): Point {
    const r = this.container.getBoundingClientRect();
    return { x: screen.x + r.left, y: screen.y + r.top };
  }

  /** The theme the board is shown in. */
  get theme(): BoardTheme {
    return this.renderer.currentTheme;
  }

  /**
   * Shows the board in `theme` (light or dark): the canvas chrome and the colours of the
   * content are drawn for it, every block renders again. Display only: the document keeps its
   * colours, nothing is written to Yjs and there is no undo step.
   */
  setTheme(theme: BoardTheme): void {
    if (theme === this.renderer.currentTheme) {
      return;
    }
    this.renderer.setTheme(theme);
    this.themeChanged.emit(theme);
    this.requestRender();
  }

  setReadOnly(readOnly: boolean): void {
    const changed = readOnly !== this._readOnly;
    this._readOnly = readOnly;
    if (changed) {
      this.readOnlyChanged.emit(readOnly);
    }
    if (readOnly) {
      this.edit?.stop();
      if (!READ_ONLY_TOOLS.includes(this.activeTool.id)) {
        this.setTool('select');
      }
    }
    this.requestRender();
  }

  /** Sets the camera as a user action (stops a running glide, emits `navigated`). */
  setCamera(camera: Camera): void {
    this.stopGlide();
    this.applyCamera(camera);
    this.navigated.emit();
  }

  /**
   * Moves the camera smoothly so that `center` (world) is in the middle of the view at `zoom`
   * (following another participant). Not a user action: `navigated` does not fire. Without
   * `requestAnimationFrame` (tests) it jumps.
   */
  glideTo(center: Point, zoom: number): void {
    const z = clampZoom(zoom);
    const target: Camera = {
      zoom: z,
      x: this.viewport.w / 2 - center.x * z,
      y: this.viewport.h / 2 - center.y * z,
    };
    if (typeof requestAnimationFrame !== 'function' || this.viewport.w === 0) {
      this.stopGlide();
      this.applyCamera(target);
      return;
    }
    this.glideTarget = target;
    this.glideFrame ??= requestAnimationFrame((t) => this.glideStep(t, t));
  }

  private glideStep(now: number, last: number): void {
    const target = this.glideTarget;
    if (!target) {
      this.glideFrame = undefined;
      return;
    }
    const next = glideCamera(this._camera, target, now - last, this.viewport);
    this.applyCamera(next);
    if (next === target) {
      this.glideTarget = undefined;
      this.glideFrame = undefined;
      return;
    }
    this.glideFrame = requestAnimationFrame((t) => this.glideStep(t, now));
  }

  private stopGlide(): void {
    if (this.glideFrame !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.glideFrame);
    }
    this.glideFrame = undefined;
    this.glideTarget = undefined;
  }

  private applyCamera(camera: Camera): void {
    this._camera = camera;
    this.renderer.setCamera(camera);
    this.cameraDirty = true;
    this.cameraChanged.emit(camera);
    this.requestRender();
  }

  hitTest(world: Point): HitResult | undefined {
    return hitTest(this.board, world, this.px(HIT_TOLERANCE));
  }

  blockAt(world: Point): string | undefined {
    return blockAt(this.board, world);
  }

  handleAt(screen: Point): HandleId | undefined {
    const id = Overlay.handleTarget(this.board, this.selection.list(), !this._readOnly);
    const box = id ? itemBounds(this.board, id) : undefined;
    if (!box) {
      return undefined;
    }
    const origin = {
      x: box.x * this._camera.zoom + this._camera.x,
      y: box.y * this._camera.zoom + this._camera.y,
    };
    const sr = { ...origin, w: box.w * this._camera.zoom, h: box.h * this._camera.zoom };
    return HANDLES.find((h) => {
      const p = handlePosition(sr, h);
      return (
        Math.abs(p.x - screen.x) <= HANDLE_HIT / 2 && Math.abs(p.y - screen.y) <= HANDLE_HIT / 2
      );
    });
  }

  px(px: number): number {
    return px / this._camera.zoom;
  }

  setHints(hints: OverlayHints): void {
    this.hints = hints;
    this.requestRender();
  }

  notify(message: string): void {
    this.clipboardNotice.emit(message);
  }

  stopCapturing(): void {
    this.history.stopCapturing();
  }

  // ---- public API for the host ---------------------------------------------------------------

  get tool(): ToolId {
    return this.activeTool.id;
  }

  setTool(id: ToolId): void {
    const next = this.tools.get(id);
    if (!next || (this._readOnly && !READ_ONLY_TOOLS.includes(id))) {
      return;
    }
    this.edit?.stop();
    this.activeTool.deactivate?.();
    this.activeTool = next;
    next.activate?.();
    this.hints = {};
    this.applyCursor();
    this.toolChanged.emit(id);
    this.requestRender();
  }

  /** Called by tools that need a drawing style (pen, shapes). Merges into `drawStyle`. */
  setDrawStyle(
    patch: Partial<{ color: string; size: number; fill: string; sticky: string; emoji: string }>,
  ): void {
    Object.assign(this.drawStyle, patch);
    this.drawStyleChanged.emit();
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_STEP);
  }

  resetZoom(): void {
    this.setCamera(setZoomAt(this._camera, this.viewportCenter(), 1));
  }

  /** Shows all content (or the origin on an empty board). */
  fit(): void {
    const ids = [...this.board.blockIds(), ...this.board.strokeIds(), ...this.board.connectorIds()];
    const bounds = unionRects(ids.flatMap((id) => itemBounds(this.board, id) ?? []));
    this.setCamera(bounds ? fitToRect(bounds, this.viewport) : { ...INITIAL_CAMERA });
  }

  undo(): void {
    if (!this._readOnly) {
      this.history.undo();
    }
  }

  redo(): void {
    if (!this._readOnly) {
      this.history.redo();
    }
  }

  get historyState(): HistoryState {
    return this.history.state;
  }

  get historyChanged(): Emitter<HistoryState> {
    return this.history.changed;
  }

  /** Applies a style change to everything selected that has that style field. */
  setStyleForSelection(patch: StylePatch): void {
    if (this._readOnly) {
      return;
    }
    this.history.stopCapturing();
    this.board.transact(() => {
      for (const id of this.selection.list()) {
        const block = this.board.getBlock(id);
        if (block) {
          const defaults = this.registry.get(block.type)?.defaultProps ?? {};
          for (const [key, value] of Object.entries(patch)) {
            if (key in defaults) {
              this.board.setProp(id, key, value);
            }
          }
        } else if (this.board.getStroke(id)) {
          const color = patch.stroke ?? patch.color;
          this.board.setStrokeStyle(id, {
            ...(color !== undefined ? { color } : {}),
            ...(patch.strokeWidth !== undefined ? { size: patch.strokeWidth } : {}),
          });
        } else if (this.board.getConnector(id)) {
          const color = patch.stroke ?? patch.color;
          this.board.setConnectorStyle(id, {
            ...(color !== undefined ? { color } : {}),
            ...(patch.strokeWidth !== undefined ? { width: patch.strokeWidth } : {}),
          });
        }
      }
    });
    this.history.stopCapturing();
  }

  /** Current style values of the selection; a key is present if some selected item has that field. */
  selectionStyle(): StyleInfo {
    const info: StyleInfo = {};
    for (const id of this.selection.list()) {
      const block = this.board.getBlock(id);
      const stroke = block ? undefined : this.board.getStroke(id);
      const connector = block || stroke ? undefined : this.board.getConnector(id);
      if (block) {
        const defaults = this.registry.get(block.type)?.defaultProps ?? {};
        for (const key of ['color', 'fill', 'stroke', 'strokeWidth'] as const) {
          const v = block.props[key];
          if (
            key in defaults &&
            info[key] === undefined &&
            (typeof v === 'string' || typeof v === 'number')
          ) {
            info[key] = v;
          }
        }
      } else if (stroke) {
        info.stroke ??= stroke.style.color;
        info.strokeWidth ??= stroke.style.size;
      } else if (connector) {
        info.stroke ??= connector.style.color;
        info.strokeWidth ??= connector.style.width;
      }
    }
    return info;
  }

  /** The selection's screen rectangle now (see `selectionAnchorChanged`). */
  get selectionAnchor(): SelectionAnchor {
    if (this._readOnly || this.gesture || this.edit || this.selection.size === 0) {
      return null;
    }
    const bounds = unionRects(
      this.selection.list().flatMap((id) => itemBounds(this.board, id) ?? []),
    );
    if (!bounds) {
      return null;
    }
    const { x, y, zoom } = this._camera;
    return {
      x: bounds.x * zoom + x,
      y: bounds.y * zoom + y,
      w: bounds.w * zoom,
      h: bounds.h * zoom,
    };
  }

  /** `sticky`, `shape`, ... if everything selected is of that kind, `mixed` otherwise. */
  selectionKind(): SelectionKind {
    const kinds = new Set<SelectionKind>();
    for (const id of this.selection.list()) {
      const block = this.board.getBlock(id);
      if (block) {
        kinds.add(
          block.type === STICKY_TYPE
            ? 'sticky'
            : block.type === TEXT_TYPE
              ? 'text'
              : block.type === SHAPE_TYPE
                ? 'shape'
                : block.type === FRAME_TYPE
                  ? 'frame'
                  : 'other',
        );
      } else if (this.board.getStroke(id)) {
        kinds.add('stroke');
      } else if (this.board.getConnector(id)) {
        kinds.add('connector');
      }
    }
    return kinds.size === 0
      ? 'none'
      : kinds.size === 1
        ? ([...kinds][0] as SelectionKind)
        : 'mixed';
  }

  /** Deletes everything selected (one undo step). */
  deleteSelection(): void {
    if (this._readOnly || this.selection.size === 0) {
      return;
    }
    this.history.stopCapturing();
    const notice = deleteWithContents(this.board, this.selection.list());
    this.selection.clear();
    this.history.stopCapturing();
    if (notice) {
      this.clipboardNotice.emit(notice);
    }
  }

  /** The frames among the selected items (not the cells of a table: those are not removed alone). */
  selectedFrames(): string[] {
    const tree = new FrameTree(this.board);
    return this.selection
      .list()
      .filter((id) => isFrame(this.board.getBlock(id)) && !cellOf(this.board, id, tree));
  }

  /**
   * The table the selection is about - one table, or one cell of an intact table (with its row
   * and column) - for the table controls of the context toolbar.
   */
  selectedTable(): SelectedTable | undefined {
    const ids = this.selection.list();
    const id = ids.length === 1 ? ids[0] : undefined;
    if (!id) {
      return undefined;
    }
    const tree = new FrameTree(this.board);
    const cell = cellOf(this.board, id, tree);
    const table = cell?.table ?? tableOf(this.board, id, tree);
    if (!table) {
      return undefined;
    }
    return {
      id: table.id,
      rows: table.rows,
      cols: table.cols,
      ...(cell ? { row: cell.row, col: cell.col } : {}),
    };
  }

  /**
   * Table controls, each one undo step: add a row below the selected cell (or at the end), a
   * column to its right (or at the end); remove the selected cell's row or column (or the last
   * one). The header row is never removed; content of removed cells stays, in the table frame.
   */
  tableAddRow(): boolean {
    return this.tableEdit((t) => addRow(this.board, t.id, t.row));
  }

  tableAddColumn(): boolean {
    return this.tableEdit((t) => addColumn(this.board, t.id, t.col));
  }

  tableRemoveRow(): boolean {
    return this.tableEdit((t) => removeRow(this.board, t.id, t.row ?? t.rows - 1));
  }

  tableRemoveColumn(): boolean {
    return this.tableEdit((t) => removeColumn(this.board, t.id, t.col ?? t.cols - 1));
  }

  private tableEdit(edit: (table: SelectedTable) => boolean): boolean {
    const table = this.selectedTable();
    if (this._readOnly || !table) {
      return false;
    }
    this.history.stopCapturing();
    const done = edit(table);
    this.history.stopCapturing();
    // the selected cell may be gone (its row or column was removed): select the table then
    this.selection.prune((id) => this.board.hasBlock(id));
    if (this.selection.size === 0) {
      this.selection.set([table.id]);
    }
    return done;
  }

  /**
   * "Remove frame, keep contents": deletes the selected frames; what was in them stays where it
   * is and moves to the next frame out (or the board). One undo step.
   */
  removeSelectedFrames(): void {
    const frames = this.selectedFrames();
    if (this._readOnly || frames.length === 0) {
      return;
    }
    // a table goes with its cells; what was in them stays
    const tree = new FrameTree(this.board);
    const cells = frames.flatMap((id) => tableOf(this.board, id, tree)?.cells.flat() ?? []);
    this.history.stopCapturing();
    removeFramesKeepContents(this.board, [...frames, ...cells]);
    this.history.stopCapturing();
  }

  /** Copies everything selected, offset a little; the copies become the selection. */
  duplicateSelection(): void {
    if (this._readOnly || this.selection.size === 0) {
      return;
    }
    this.history.stopCapturing();
    this.selection.set(duplicateWithContents(this.board, this.selection.list()));
    this.history.stopCapturing();
  }

  /**
   * The selection as clipboard content (also on a read-only board: looking includes copying).
   * Undefined when nothing is selected or the selection is too large (with a notice).
   */
  copySelection(): ClipboardContent | undefined {
    return this.copy(false);
  }

  /** Copies the selection and deletes what was copied (one undo step); not on read-only boards. */
  cutSelection(): ClipboardContent | undefined {
    return this.copy(true);
  }

  /**
   * Pastes clipboard content at the pointer (or the middle of the view when the pointer is not
   * over the board): board content after validation (S5.5), else plain text as one sticky
   * note. Returns true if the paste was taken (also when it was refused with a notice).
   */
  paste(data: PasteData): boolean {
    if (this._readOnly) {
      return false;
    }
    if (data.json) {
      this.pasteBoardContent(data.json);
      return true;
    }
    const text = data.text?.trim() ? data.text : undefined;
    if (!text) {
      return false;
    }
    this.insertBlock({
      type: STICKY_TYPE,
      at: this.pastePoint(`text:${text}`),
      props: { color: this.drawStyle.sticky },
      text: text.slice(0, MAX_TEXT_LENGTH),
    });
    return true;
  }

  /** InputTarget: a `copy` or `cut` ClipboardEvent on the board. */
  copy(cut: boolean): ClipboardContent | undefined {
    if (this.selection.size === 0 || (cut && this._readOnly)) {
      return undefined;
    }
    const result = copyToClipboard(this.board, this.selection.list(), this.boardId);
    if ('error' in result) {
      this.clipboardNotice.emit(result.error);
      return undefined;
    }
    if (cut) {
      const { blocks, connectors, strokes } = result.set;
      this.history.stopCapturing();
      this.board.deleteItems([...blocks, ...connectors, ...strokes]);
      this.selection.clear();
      this.history.stopCapturing();
    }
    return result.content;
  }

  private pasteBoardContent(json: string): void {
    // block types of the plugins enabled on this board (the built-ins are the trusted ones)
    const pluginTypes = new Set(
      this.registry
        .list()
        .filter((t) => !t.trusted)
        .map((t) => t.type),
    );
    let envelope;
    try {
      envelope = parseClipboard(json, { pluginTypes });
    } catch (error) {
      if (error instanceof ImportError) {
        this.clipboardNotice.emit(error.message);
        return;
      }
      throw error;
    }
    const at = this.pastePoint(json);
    this.history.stopCapturing();
    let result: PasteResult = { ids: [], topLevel: [], droppedFiles: 0 };
    this.board.transact(() => {
      result = pasteClipboard(this.board, envelope, { at, targetBoard: this.boardId });
      // pasted onto a frame: what was top-level in the copy joins it
      assignParents(this.board, result.topLevel);
    });
    this.history.stopCapturing();
    this.selection.set(result.ids);
    const notes: string[] = [];
    if (envelope.skippedTypes > 0) {
      notes.push(
        `${count(envelope.skippedTypes, 'block')} of plugins that are not enabled on this board ${envelope.skippedTypes === 1 ? 'was' : 'were'} left out.`,
      );
    }
    if (result.droppedFiles > 0) {
      notes.push(
        `${count(result.droppedFiles, 'file')} ${result.droppedFiles === 1 ? 'was' : 'were'} left out: files can only be pasted into the board they belong to.`,
      );
    }
    if (notes.length > 0) {
      this.clipboardNotice.emit(notes.join(' '));
    }
  }

  /**
   * Where a paste goes: the pointer, or the middle of the view. Pasting the same content at the
   * same spot again steps down and right, so the copies do not hide each other.
   */
  private pastePoint(key: string): Point {
    const at = this.lastCursor ?? this.visibleCenter();
    const last = this.lastPaste;
    const count =
      last && last.key === key && last.at.x === at.x && last.at.y === at.y ? last.count + 1 : 0;
    this.lastPaste = { key, at, count };
    return { x: at.x + count * PASTE_OFFSET, y: at.y + count * PASTE_OFFSET };
  }

  /** The world point under a viewport (client) position, e.g. of a drop. */
  worldAtClient(clientX: number, clientY: number): Point {
    const r = this.container.getBoundingClientRect();
    return screenToWorld(this._camera, { x: clientX - r.left, y: clientY - r.top });
  }

  /** The world point in the middle of the visible area (where pasted things go). */
  visibleCenter(): Point {
    return screenToWorld(this._camera, this.viewportCenter());
  }

  /**
   * Adds a block centred on `at` as one undo step and selects it (uploads, pasted diagrams).
   * Returns the new id, or undefined on a read-only board or for an unknown type.
   */
  insertBlock(input: {
    type: string;
    at: Point;
    size?: Size;
    props?: Record<string, unknown>;
    text?: string;
  }): string | undefined {
    const type = this.registry.get(input.type);
    if (this._readOnly || !type) {
      return undefined;
    }
    const size = input.size ?? type.defaultSize;
    this.history.stopCapturing();
    const id = this.board.addBlock({
      type: type.type,
      x: input.at.x - size.w / 2,
      y: input.at.y - size.h / 2,
      w: size.w,
      h: size.h,
      props: { ...type.defaultProps, ...input.props },
      text: input.text,
    });
    // dropped onto a frame: it belongs to it (same undo step)
    assignParents(this.board, [id]);
    this.history.stopCapturing();
    this.selection.set([id]);
    return id;
  }

  /** See `BlockType.opensEditor`; nothing on a read-only board. */
  openBlock(blockId: string): void {
    if (!this._readOnly && this.board.hasBlock(blockId)) {
      this.blockOpened.emit(blockId);
    }
  }

  /**
   * Replaces the text of a block from an editor outside the canvas (diagram source) as the
   * smallest edit of its Y.Text, so concurrent edits of others survive. False if the block has
   * no text or the board is read-only.
   */
  setBlockText(blockId: string, text: string): boolean {
    const yText = this.board.getText(blockId);
    if (this._readOnly || !yText) {
      return false;
    }
    applyTextDiff(this.board, yText, text);
    return true;
  }

  /** Remote participants in, drawn as cursors and selection outlines. */
  setPeers(peers: PeerPresence[]): void {
    this.peers = peers;
    this.requestRender();
  }

  startTextEdit(blockId: string, options: { deleteIfEmpty?: boolean } = {}): void {
    if (this._readOnly) {
      return;
    }
    this.edit?.stop();
    const el = this.renderer.blockElement(blockId);
    if (!el || this.renderer.simpleMode) {
      return;
    }
    this.renderer.setEditing(blockId, true);
    const type = this.registry.get(this.board.getBlock(blockId)?.type ?? '');
    // a block may name the part of it the editor opens in (a frame: its title strip)
    const host = el.querySelector<HTMLElement>('[data-be-text-host]') ?? el;
    const session = startTextEditor(
      this.board,
      host,
      blockId,
      () => {
        this.renderer.setEditing(blockId, false);
        this.edit = undefined;
        this.requestRender();
        if (
          options.deleteIfEmpty &&
          this.board.hasBlock(blockId) &&
          this.board.textOf(blockId) === ''
        ) {
          this.board.deleteItems([blockId]);
        }
        this.container.focus({ preventScroll: true });
      },
      { maxLength: type?.textMaxLength },
    );
    if (session) {
      this.edit = session;
      this.requestRender();
    } else {
      this.renderer.setEditing(blockId, false);
    }
  }

  /** The screen rectangle of the block whose text is edited now (see `textEditAnchorChanged`). */
  get textEditAnchor(): SelectionAnchor {
    const block = this.edit ? this.board.getBlock(this.edit.blockId) : undefined;
    if (!block) {
      return null;
    }
    const { x, y, zoom } = this._camera;
    return { x: block.x * zoom + x, y: block.y * zoom + y, w: block.w * zoom, h: block.h * zoom };
  }

  /**
   * Puts text at the caret of the open text editor - the way typing does (one Yjs edit, so undo
   * works and others see it). False if no text is edited or the text would be too long.
   */
  insertIntoEditedText(text: string): boolean {
    return this.edit?.insert(text) ?? false;
  }

  /**
   * Keeps the open text editor alive while a panel next to it (the emoji picker) takes the
   * focus: the editor then does not end on blur. The returned function gives the focus back.
   * Undefined if no text is edited.
   */
  holdTextEdit(): (() => void) | undefined {
    return this.edit?.hold();
  }

  /** Renders pending changes now (tests; the engine otherwise renders on the next frame). */
  flush(): void {
    this.scheduled = false;
    if (this.cameraDirty) {
      this.cameraDirty = false;
      this.renderer.reconcile();
      // far out the blocks are plain boxes: an open text editor has nothing left to edit in
      if (this.renderer.simpleMode) {
        this.edit?.stop();
      }
    }
    this.renderer.renderOverlay({
      camera: this._camera,
      selection: this.selection.list(),
      hints: this.hints,
      peers: this.peers,
      canResize: !this._readOnly,
    });
    this.emitAnchor();
  }

  setViewportSize(size: Size): void {
    const changed = size.w !== this.viewport.w || size.h !== this.viewport.h;
    this.viewport = size;
    this.renderer.setViewport(size);
    this.requestRender();
    if (changed) {
      this.viewportResized.emit(size);
    }
  }

  /** Test and plugin hook: the element of a mounted block. */
  blockElement(id: string): HTMLElement | undefined {
    return this.renderer.blockElement(id);
  }

  get mountedBlockCount(): number {
    return this.renderer.mountedCount;
  }

  /** Block views created so far (tests: panning far out must not remount anything). */
  get blockMountCount(): number {
    return this.renderer.mountCount;
  }

  /** True while blocks render as plain boxes (zoom below SIMPLE_ZOOM). */
  get simplified(): boolean {
    return this.renderer.simpleMode;
  }

  destroy(): void {
    this.stopGlide();
    this.edit?.stop();
    this.input.destroy();
    this.resizeObserver?.disconnect();
    for (const u of this.unsubscribe) {
      u();
    }
    this.unsubscribe.length = 0;
    this.history.destroy();
    this.renderer.destroy();
    for (const e of [
      this.toolChanged,
      this.cameraChanged,
      this.viewportResized,
      this.navigated,
      this.drawStyleChanged,
      this.localPresence,
      this.selectionAnchorChanged,
      this.textEditAnchorChanged,
      this.blockRequested,
      this.clipboardNotice,
    ]) {
      e.clear();
    }
  }

  // ---- InputTarget ---------------------------------------------------------------------------

  pointerDown(e: PointerInfo): void {
    this.edit?.stop();
    if ((e.buttons & 4) !== 0 || this.spaceHeld) {
      this.panning = true;
      this.hand.pointerDown(e);
      this.applyCursor();
      return;
    }
    this.gesture = true;
    this.activeTool.pointerDown(e);
  }

  pointerMove(e: PointerInfo): void {
    this.lastCursor = e.world;
    this.localPresence.emit({ cursor: e.world, selection: this.selection.list() });
    if (this.panning) {
      this.hand.pointerMove(e);
    } else {
      this.activeTool.pointerMove(e);
      this.applyCursor();
    }
    this.requestRender();
  }

  pointerUp(e: PointerInfo): void {
    if (this.panning) {
      this.panning = false;
      this.hand.pointerUp();
      this.applyCursor();
      return;
    }
    this.gesture = false;
    this.activeTool.pointerUp(e);
    this.requestRender();
  }

  pointerCancel(): void {
    if (this.panning) {
      this.panning = false;
      this.hand.pointerCancel();
    }
    this.gesture = false;
    this.activeTool.pointerCancel?.();
    this.requestRender();
  }

  pointerLeave(): void {
    this.lastCursor = null;
    this.localPresence.emit({ cursor: null, selection: this.selection.list() });
  }

  doubleClick(e: PointerInfo): void {
    this.activeTool.doubleClick?.(e);
  }

  wheel(e: WheelInfo): void {
    if (e.zoom) {
      const clamped = Math.max(-50, Math.min(50, e.deltaY));
      this.setCamera(zoomAt(this._camera, e.screen, Math.exp(-clamped * 0.01)));
    } else {
      this.setCamera(panBy(this._camera, -e.deltaX, -e.deltaY));
    }
  }

  pinch(center: Point, scale: number, dx: number, dy: number): void {
    this.setCamera(panBy(zoomAt(this._camera, center, scale), dx, dy));
  }

  keyDown(e: KeyInfo): boolean {
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        this.applyCursor();
      }
      return true;
    }
    if (e.mod && key === 'z') {
      if (e.shift) {
        this.redo();
      } else {
        this.undo();
      }
      return true;
    }
    if (e.mod && key === 'y') {
      this.redo();
      return true;
    }
    if (this.zoomKey(e)) {
      return true;
    }
    const shortcut = TOOL_SHORTCUTS[key];
    if (shortcut && !e.mod && !e.alt) {
      this.setTool(shortcut);
      return true;
    }
    if (this.activeTool.keyDown?.(e)) {
      return true;
    }
    // Delete, Escape, mod+A ... work with every tool
    return this.activeTool.id !== 'select' && (this.tools.get('select')?.keyDown?.(e) ?? false);
  }

  keyUp(e: KeyInfo): void {
    if (e.key === ' ') {
      this.spaceHeld = false;
      this.applyCursor();
    }
  }

  // ---- internals -----------------------------------------------------------------------------

  private emitAnchor(): void {
    const next = this.selectionAnchor;
    if (!sameRect(next, this.lastAnchor)) {
      this.lastAnchor = next;
      this.selectionAnchorChanged.emit(next);
    }
    const edit = this.textEditAnchor;
    if (!sameRect(edit, this.lastEditAnchor)) {
      this.lastEditAnchor = edit;
      this.textEditAnchorChanged.emit(edit);
    }
  }

  /**
   * Zoom shortcuts (Miro's): mod + plus / minus zoom in and out, mod+0 and Shift+0 go to 100 %,
   * Shift+1 fits the whole board. Digits by physical key, so they work on every layout.
   */
  private zoomKey(e: KeyInfo): boolean {
    const digit = e.code?.startsWith('Digit') ? e.code.slice(5) : e.key;
    if (e.mod && !e.alt && (e.key === '+' || e.key === '=')) {
      this.zoomIn();
    } else if (e.mod && !e.alt && (e.key === '-' || e.key === '_')) {
      this.zoomOut();
    } else if (!e.alt && digit === '0' && (e.mod || e.shift)) {
      this.resetZoom();
    } else if (!e.alt && !e.mod && e.shift && (digit === '1' || e.key === '!')) {
      this.fit();
    } else {
      return false;
    }
    return true;
  }

  private zoomBy(factor: number): void {
    this.setCamera(zoomAt(this._camera, this.viewportCenter(), factor));
  }

  private viewportCenter(): Point {
    return { x: this.viewport.w / 2, y: this.viewport.h / 2 };
  }

  private measure(): void {
    this.setViewportSize({ w: this.container.clientWidth, h: this.container.clientHeight });
  }

  private applyCursor(): void {
    this.container.style.cursor = this.panning
      ? 'grabbing'
      : this.spaceHeld
        ? 'grab'
        : this.activeTool.cursor;
  }

  private requestRender(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => this.flush());
    } else {
      queueMicrotask(() => this.flush());
    }
  }
}

function sameRect(a: SelectionAnchor, b: SelectionAnchor): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
