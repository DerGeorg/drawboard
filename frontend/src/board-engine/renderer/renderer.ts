import {
  Camera,
  visibleWorldRect,
  BoardDoc,
  FrameTree,
  isFrame,
  BlockData,
  BoardChange,
  Rect,
  Size,
  rectsIntersect,
  BOARD_THEME_VARS,
  BoardTheme,
} from '@apps/drawboard-engine';
import { BlockHost, BlockTypeRegistry, BlockView } from './block-registry';
import { applyGrid } from '../grid';
import { Overlay, OverlayState } from './overlay';
import { SvgLayer } from './svg-layer';
import { INV_ZOOM_VAR, renderSimple, simpleAt, simpleFillOf } from './simple-view';

interface Mounted {
  el: HTMLElement;
  view: BlockView;
  /** Mounted in the frames layer. */
  frame: boolean;
  /** A plain box of the far-out level of detail (see simple-view.ts). */
  simple: boolean;
}

/** How far outside the viewport (screen pixels) blocks stay mounted. */
export const CULL_MARGIN = 300;

/** z-index band per frame depth: a nested frame always paints above the frame around it. */
const DEPTH_BAND = 2 ** 26;

/** The z-index of a frame inside the frames layer: depth first, then its own z. */
export function frameZIndex(depth: number, z: number): number {
  return depth * DEPTH_BAND + Math.min(DEPTH_BAND - 1, Math.max(0, Math.trunc(z)));
}

/**
 * The DOM of the board: a world `div` with one CSS transform, one element per visible block,
 * an SVG layer in world space and an overlay in screen space. Re-renders from document changes,
 * never on a timer.
 */
export class Renderer {
  readonly world: HTMLElement;
  /** Frames: below connectors and every other block (they hold those blocks). */
  readonly framesLayer: HTMLElement;
  readonly blocksLayer: HTMLElement;
  readonly svgLayer: SvgLayer;
  readonly overlay: Overlay;
  private readonly mounted = new Map<string, Mounted>();
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private viewport: Size = { w: 0, h: 0 };
  private readonly offRegistry: () => void;
  /** The frame tree of the current document state (depths of frames); dropped on every change. */
  private tree: FrameTree | undefined;
  /** Far zoomed out: blocks are plain boxes (switches in `reconcile`). */
  private simple = false;
  /** Blocks mounted since the start: tests check that panning does not remount anything. */
  private mounts = 0;
  private theme: BoardTheme = 'light';

  constructor(
    private readonly container: HTMLElement,
    private readonly board: BoardDoc,
    private readonly registry: BlockTypeRegistry,
    private readonly isReadOnly: () => boolean,
    /** Write access for trusted built-in block types (never plugins). */
    private readonly blockHost?: BlockHost,
    theme: BoardTheme = 'light',
  ) {
    this.theme = theme;
    const doc = container.ownerDocument;
    this.world = doc.createElement('div');
    this.world.className = 'be-world';
    this.world.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0';
    // two stacking contexts: frames (0) under the connectors (auto, painted after the frames)
    // under all other blocks (1) - whatever z a block has
    this.framesLayer = doc.createElement('div');
    this.framesLayer.className = 'be-frames';
    this.framesLayer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:0';
    this.blocksLayer = doc.createElement('div');
    this.blocksLayer.className = 'be-blocks';
    this.blocksLayer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:1';
    this.svgLayer = new SvgLayer(doc, board);
    this.world.append(this.framesLayer, this.svgLayer.svg, this.blocksLayer);
    this.overlay = new Overlay(doc, board);
    container.append(this.world, this.overlay.svg);
    this.applyTheme();
    this.applyCamera();
    this.offRegistry = registry.changed.on((types) => this.remountTypes(types));
  }

  /** Block types came or went (plugins): their mounted blocks render again with the new type. */
  private remountTypes(types: ReadonlySet<string>): void {
    for (const id of [...this.mounted.keys()]) {
      const block = this.board.getBlock(id);
      if (block && types.has(block.type)) {
        this.unmount(id);
        this.mount(block);
      }
    }
  }

  get currentTheme(): BoardTheme {
    return this.theme;
  }

  /**
   * Shows the board in `theme`: the chrome variables change on the container, every mounted block
   * gets `update` (content colours are mapped, see theme.ts) and connectors and strokes are drawn
   * again. The document is not touched.
   */
  setTheme(theme: BoardTheme): void {
    if (theme === this.theme) {
      return;
    }
    this.theme = theme;
    this.applyTheme();
    // a copy: a simple box is unmounted and mounted again below
    for (const [id, m] of [...this.mounted]) {
      const block = this.board.getBlock(id);
      if (!block) {
        continue;
      }
      if (m.simple) {
        // a simple box is one element: build it again with the colour of the new theme
        this.unmount(id);
        this.mount(block);
      } else {
        this.update(id, block);
      }
    }
    this.svgLayer.setTheme(theme);
  }

  /** The `--be-*` variables of the theme on the container (blocks and the editor read them). */
  private applyTheme(): void {
    const style = this.container.style;
    for (const [name, value] of Object.entries(BOARD_THEME_VARS[this.theme])) {
      style.setProperty(name, value);
    }
    this.container.dataset['beTheme'] = this.theme;
  }

  get mountedCount(): number {
    return this.mounted.size;
  }

  /** How many block views were created so far (mounts, not mounted blocks). */
  get mountCount(): number {
    return this.mounts;
  }

  /** True while blocks render as plain boxes (zoomed far out). */
  get simpleMode(): boolean {
    return this.simple;
  }

  blockElement(id: string): HTMLElement | undefined {
    return this.mounted.get(id)?.el;
  }

  setViewport(size: Size): void {
    this.viewport = size;
    this.reconcile();
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.applyCamera();
  }

  renderAll(): void {
    this.reconcile();
    this.svgLayer.renderAll();
  }

  /** Re-renders what a document change touched. */
  applyChange(change: BoardChange): void {
    this.tree = undefined;
    // a frame came, went, moved between frames: the depths of the frames may have changed
    let frames = false;
    for (const id of change.blocks) {
      const block = this.board.getBlock(id);
      frames ||= isFrame(block) || this.mounted.get(id)?.frame === true;
      if (!block) {
        this.unmount(id);
      } else if (this.mounted.has(id)) {
        this.update(id, block);
      } else if (this.isVisible(block)) {
        this.mount(block);
      }
    }
    const connectors = new Set(change.connectors);
    for (const id of this.svgLayer.connectorsAttachedTo(change.blocks)) {
      connectors.add(id);
    }
    this.svgLayer.syncConnectors(connectors);
    this.svgLayer.syncStrokes(change.strokes);
    if (frames) {
      for (const [id, m] of this.mounted) {
        const block = m.frame ? this.board.getBlock(id) : undefined;
        if (block) {
          m.el.style.zIndex = String(this.zIndex(block));
        }
      }
    }
  }

  /**
   * Mounts blocks that scrolled into view and unmounts those that left it; switches between full
   * views and plain boxes when the zoom crossed the level-of-detail threshold.
   */
  reconcile(): void {
    const simple = simpleAt(this.camera.zoom, this.simple);
    if (simple !== this.simple) {
      this.simple = simple;
      for (const id of [...this.mounted.keys()]) {
        this.unmount(id);
      }
    }
    const area = this.cullRect();
    for (const block of this.board.blocks()) {
      const should = area === undefined || rectsIntersect(block, area);
      if (should && !this.mounted.has(block.id)) {
        this.mount(block);
      } else if (!should && this.mounted.has(block.id)) {
        this.unmount(block.id);
      }
    }
    for (const id of [...this.mounted.keys()]) {
      if (!this.board.hasBlock(id)) {
        this.unmount(id);
      }
    }
  }

  renderOverlay(state: OverlayState): void {
    this.overlay.render(state);
  }

  setEditing(id: string, editing: boolean): void {
    const el = this.mounted.get(id)?.el;
    if (el) {
      el.dataset['editing'] = editing ? 'true' : 'false';
      // Hide only the text, not the element: on a sticky the `.be-text` element also paints the
      // note's background, which must stay visible under the (translucent) editor.
      for (const t of Array.from(el.querySelectorAll<HTMLElement>('.be-text'))) {
        if (editing && t.dataset['textColor'] === undefined) {
          t.dataset['textColor'] = t.style.color;
          t.style.color = 'transparent';
        } else if (!editing && t.dataset['textColor'] !== undefined) {
          t.style.color = t.dataset['textColor'];
          delete t.dataset['textColor'];
        }
        for (const child of Array.from(t.querySelectorAll<HTMLElement>('*'))) {
          child.style.visibility = editing ? 'hidden' : '';
        }
      }
    }
  }

  destroy(): void {
    this.offRegistry();
    for (const id of [...this.mounted.keys()]) {
      this.unmount(id);
    }
    this.svgLayer.destroy();
    this.world.remove();
    this.overlay.svg.remove();
  }

  private applyCamera(): void {
    const { x, y, zoom } = this.camera;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    // the dot grid is the container's background: no element per dot
    applyGrid(this.container, this.camera);
    // lengths in screen pixels inside the world (simple frames' outline and title)
    this.world.style.setProperty(INV_ZOOM_VAR, String(1 / zoom));
  }

  /**
   * The world area whose blocks are mounted: the viewport plus CULL_MARGIN screen pixels, or
   * undefined while the viewport is unmeasured (tests, hidden container: everything is mounted).
   * Computed once per pass, so a pass over thousands of blocks is one rectangle test each.
   */
  private cullRect(): Rect | undefined {
    if (this.viewport.w === 0 && this.viewport.h === 0) {
      return undefined;
    }
    const view = visibleWorldRect(this.camera, this.viewport);
    const m = CULL_MARGIN / this.camera.zoom;
    return { x: view.x - m, y: view.y - m, w: view.w + m * 2, h: view.h + m * 2 };
  }

  private isVisible(b: BlockData): boolean {
    const area = this.cullRect();
    return area === undefined || rectsIntersect(b, area);
  }

  private mount(block: BlockData): void {
    const doc = this.container.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'be-block';
    el.dataset['blockId'] = block.id;
    el.dataset['blockType'] = block.type;
    el.style.position = 'absolute';
    this.applyGeometry(el, block);
    const type = this.registry.get(block.type);
    this.mounts++;
    if (this.simple) {
      this.attach(
        block,
        el,
        renderSimple(
          el,
          block,
          (b) => simpleFillOf(this.registry.get(b.type), b, this.theme),
          (b) => this.board.textOf(b.id),
        ),
        true,
      );
      return;
    }
    let view: BlockView;
    try {
      if (!type) {
        throw new Error('unknown block type');
      }
      view = type.render(el, {
        block,
        text: () => this.board.textOf(block.id),
        readOnly: this.isReadOnly(),
        theme: () => this.theme,
        ...(type.trusted ? { host: this.blockHost } : {}),
      });
    } catch {
      view = placeholder(el, block.type);
    }
    this.attach(block, el, view, false);
  }

  private attach(block: BlockData, el: HTMLElement, view: BlockView, simple: boolean): void {
    const frame = isFrame(block);
    el.dataset['lod'] = simple ? 'simple' : 'full';
    (frame ? this.framesLayer : this.blocksLayer).appendChild(el);
    this.mounted.set(block.id, { el, view, frame, simple });
    try {
      view.mounted?.();
    } catch {
      // see update()
    }
  }

  private update(id: string, block: BlockData): void {
    const m = this.mounted.get(id);
    if (!m) {
      return;
    }
    this.applyGeometry(m.el, block);
    try {
      m.view.update(block);
    } catch {
      // a broken plugin view must not take the board down
    }
  }

  private unmount(id: string): void {
    const m = this.mounted.get(id);
    if (!m) {
      return;
    }
    try {
      m.view.destroy();
    } catch {
      // see update()
    }
    m.el.remove();
    this.mounted.delete(id);
  }

  private zIndex(b: BlockData): number {
    if (!isFrame(b)) {
      return Math.trunc(b.z);
    }
    this.tree ??= new FrameTree(this.board);
    return frameZIndex(this.tree.depth(b.id), b.z);
  }

  private applyGeometry(el: HTMLElement, b: BlockData): void {
    const s = el.style;
    s.left = `${b.x}px`;
    s.top = `${b.y}px`;
    s.width = `${b.w}px`;
    s.height = `${b.h}px`;
    s.zIndex = String(this.zIndex(b));
    s.transform = b.rotation ? `rotate(${b.rotation}deg)` : '';
  }
}

/**
 * Unknown or broken block types stay in the document and show as a placeholder. A type outside
 * `core.*` belongs to a plugin that is missing, disabled or removed: the placeholder names it
 * (S3.10, S3.11) and the data is kept for when it comes back.
 */
function placeholder(host: HTMLElement, type: string): BlockView {
  const box = host.ownerDocument.createElement('div');
  box.className = 'be-placeholder';
  box.style.cssText =
    'width:100%;height:100%;box-sizing:border-box;border:2px dashed #94a3b8;border-radius:6px;' +
    'display:flex;align-items:center;justify-content:center;font:12px system-ui,sans-serif;color:var(--be-text-3,#64748b);text-align:center;padding:8px';
  const plugin = type.startsWith('core.') ? undefined : type.slice(0, type.lastIndexOf('.'));
  box.textContent = plugin
    ? `Plugin: ${plugin} - not available. The block keeps its data.`
    : `Unknown block type: ${type}`;
  host.replaceChildren(box);
  return { update: () => undefined, destroy: () => box.remove() };
}
