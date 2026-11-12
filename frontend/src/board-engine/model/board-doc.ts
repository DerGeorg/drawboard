import * as Y from 'yjs';

import {
  Anchor,
  BlockData,
  BoardChange,
  ConnectorData,
  ConnectorEnd,
  ConnectorStyle,
  MAX_TEXT_LENGTH,
  Point,
  Props,
  Rect,
  SCHEMA_VERSION,
  StrokeData,
  StrokeStyle,
  isBlockEnd,
} from './types';

/** Transaction origin of every local edit; the undo manager tracks only this one. */
export const LOCAL_ORIGIN = 'drawboard-local';

export interface NewBlock {
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  props?: Props;
  /** Creates a Y.Text with this content. */
  text?: string;
  rotation?: number;
  parent?: string | null;
}

export const DEFAULT_CONNECTOR_STYLE: ConnectorStyle = {
  color: '#334155',
  width: 2,
  arrow: true,
  dashed: false,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyType = Y.AbstractType<any>;

type Listener = (change: BoardChange) => void;

/**
 * The board's data over one Y.Doc (architecture 3.3): `meta`, `blocks`, `connectors`, `strokes`.
 * Typed reads, and mutations that each run in one transaction with LOCAL_ORIGIN. The model does
 * not know about tools, the camera or the DOM.
 */
export class BoardDoc {
  readonly meta: Y.Map<unknown>;
  readonly blocksMap: Y.Map<Y.Map<unknown>>;
  readonly connectorsMap: Y.Map<Y.Map<unknown>>;
  readonly strokesMap: Y.Map<Y.Map<unknown>>;

  private readonly listeners = new Set<Listener>();
  private readonly blockCache = new Map<string, BlockData>();
  private readonly afterTransaction = (tr: Y.Transaction): void => this.onTransaction(tr);

  /**
   * @param initialize write the schema version into a fresh document. Pass `false` for a
   * document that syncs with a server and call `initialize()` after the first sync, so the
   * initial write is not lost or doubled.
   */
  constructor(
    readonly doc: Y.Doc = new Y.Doc(),
    initialize = true,
  ) {
    this.meta = doc.getMap('meta');
    this.blocksMap = doc.getMap('blocks');
    this.connectorsMap = doc.getMap('connectors');
    this.strokesMap = doc.getMap('strokes');
    doc.on('afterTransaction', this.afterTransaction);
    if (initialize) {
      this.initialize();
    }
  }

  /** Writes the schema version if the document has none (a brand-new board). */
  initialize(): void {
    if (this.meta.get('schemaVersion') === undefined) {
      this.doc.transact(() => this.meta.set('schemaVersion', SCHEMA_VERSION), LOCAL_ORIGIN);
    }
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.afterTransaction);
    this.listeners.clear();
  }

  /** Groups several mutations into one transaction (one undo step, one update on the wire). */
  transact(fn: () => void): void {
    this.doc.transact(fn, LOCAL_ORIGIN);
  }

  /** Subscribes to changes (local, remote and undo). Returns the unsubscribe function. */
  observe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get schemaVersion(): number {
    return (this.meta.get('schemaVersion') as number | undefined) ?? SCHEMA_VERSION;
  }

  // ---- blocks: reads -------------------------------------------------------------------------

  blockIds(): string[] {
    return Array.from(this.blocksMap.keys());
  }

  blocks(): BlockData[] {
    return this.blockIds().flatMap((id) => this.getBlock(id) ?? []);
  }

  hasBlock(id: string): boolean {
    return this.blocksMap.has(id);
  }

  getBlock(id: string): BlockData | undefined {
    // inside a transaction the cache may be stale (it is cleared after the transaction): read
    // the maps, and do not cache what may still change
    const inTransaction = this.doc._transaction !== null;
    const cached = inTransaction ? undefined : this.blockCache.get(id);
    if (cached) {
      return cached;
    }
    const m = this.blocksMap.get(id);
    if (!m) {
      return undefined;
    }
    const props = m.get('props') as Y.Map<unknown> | undefined;
    const block: BlockData = {
      id,
      type: str(m.get('type'), 'unknown'),
      x: num(m.get('x')),
      y: num(m.get('y')),
      w: num(m.get('w'), 100),
      h: num(m.get('h'), 100),
      rotation: num(m.get('rotation')),
      z: num(m.get('z')),
      parent: typeof m.get('parent') === 'string' ? (m.get('parent') as string) : null,
      locked: m.get('locked') === true,
      props: props ? (props.toJSON() as Props) : {},
      hasText: m.get('text') instanceof Y.Text,
    };
    if (!inTransaction) {
      this.blockCache.set(id, block);
    }
    return block;
  }

  /**
   * Type, geometry and parent of a block, read straight from the maps (no props, no cache):
   * cheap enough for the frame rules, which look at every block, also inside a transaction.
   */
  blockShape(id: string): BlockShape | undefined {
    const m = this.blocksMap.get(id);
    return m ? shapeOf(id, m) : undefined;
  }

  blockShapes(): BlockShape[] {
    return Array.from(this.blocksMap.entries(), ([id, m]) => shapeOf(id, m));
  }

  getText(id: string): Y.Text | undefined {
    const t = this.blocksMap.get(id)?.get('text');
    return t instanceof Y.Text ? t : undefined;
  }

  textOf(id: string): string {
    return this.getText(id)?.toString() ?? '';
  }

  maxZ(): number {
    let max = 0;
    for (const m of this.blocksMap.values()) {
      max = Math.max(max, num(m.get('z')));
    }
    return max;
  }

  // ---- blocks: mutations ---------------------------------------------------------------------

  addBlock(input: NewBlock): string {
    const id = crypto.randomUUID();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      this.blocksMap.set(id, m);
      m.set('id', id);
      m.set('type', input.type);
      m.set('x', input.x);
      m.set('y', input.y);
      m.set('w', input.w);
      m.set('h', input.h);
      m.set('rotation', input.rotation ?? 0);
      m.set('z', this.maxZ() + 1);
      m.set('parent', input.parent ?? null);
      m.set('locked', false);
      const props = new Y.Map<unknown>();
      m.set('props', props);
      for (const [k, v] of Object.entries(input.props ?? {})) {
        props.set(k, v);
      }
      if (input.text !== undefined) {
        const t = new Y.Text();
        m.set('text', t);
        t.insert(0, input.text.slice(0, MAX_TEXT_LENGTH));
      }
    });
    return id;
  }

  setGeometry(id: string, rect: Partial<Rect>): void {
    const m = this.blocksMap.get(id);
    if (!m) {
      return;
    }
    this.transact(() => {
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        const v = rect[k];
        if (v !== undefined && Number.isFinite(v) && m.get(k) !== v) {
          m.set(k, v);
        }
      }
    });
  }

  setBlockFlag(id: string, key: 'locked', value: boolean): void {
    const m = this.blocksMap.get(id);
    if (m && m.get(key) !== value) {
      this.transact(() => m.set(key, value));
    }
  }

  setProp(id: string, key: string, value: unknown): void {
    const props = this.blocksMap.get(id)?.get('props') as Y.Map<unknown> | undefined;
    if (props && props.get(key) !== value) {
      this.transact(() => props.set(key, value));
    }
  }

  /** Replaces all props of a block in one transaction (keys absent from `props` are removed). */
  replaceProps(id: string, props: Props): void {
    const map = this.blocksMap.get(id)?.get('props') as Y.Map<unknown> | undefined;
    if (!map) {
      return;
    }
    this.transact(() => {
      for (const key of [...map.keys()]) {
        if (!Object.hasOwn(props, key)) {
          map.delete(key);
        }
      }
      for (const [key, value] of Object.entries(props)) {
        if (JSON.stringify(map.get(key)) !== JSON.stringify(value)) {
          map.set(key, value);
        }
      }
    });
  }

  /**
   * A deep copy of a block's props for another block: nested Yjs types (kanban columns and
   * cards, story criteria) are cloned as types, plain values copied.
   */
  cloneProps(id: string): Props {
    const map = this.blocksMap.get(id)?.get('props');
    const out: Props = {};
    if (map instanceof Y.Map) {
      for (const [key, value] of (map as Y.Map<unknown>).entries()) {
        // defineProperty: a key "__proto__" written by a foreign client stays a plain key
        Object.defineProperty(out, key, {
          value: value instanceof Y.AbstractType ? value.clone() : structuredClone(value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return out;
  }

  bringToFront(ids: Iterable<string>): void {
    this.transact(() => {
      let z = this.maxZ();
      for (const id of ids) {
        this.blocksMap.get(id)?.set('z', ++z);
      }
    });
  }

  /** Moves blocks, strokes and the free ends of connectors by the same delta. */
  moveItems(ids: Iterable<string>, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) {
      return;
    }
    const set = new Set(ids);
    this.transact(() => {
      for (const id of set) {
        const b = this.blocksMap.get(id);
        if (b) {
          if (b.get('locked') !== true) {
            b.set('x', num(b.get('x')) + dx);
            b.set('y', num(b.get('y')) + dy);
          }
          continue;
        }
        const s = this.strokesMap.get(id);
        if (s) {
          s.set('points', movePoints(s.get('points') as number[], dx, dy));
          continue;
        }
        const c = this.connectorsMap.get(id);
        if (c) {
          for (const end of ['from', 'to'] as const) {
            const e = c.get(end) as ConnectorEnd;
            if (!isBlockEnd(e)) {
              c.set(end, { x: e.x + dx, y: e.y + dy });
            }
          }
        }
      }
    });
  }

  /** Deletes blocks, connectors and strokes by id; connectors attached to a deleted block go too. */
  deleteItems(ids: Iterable<string>): void {
    const set = new Set(ids);
    this.transact(() => {
      for (const id of set) {
        this.blocksMap.delete(id);
        this.connectorsMap.delete(id);
        this.strokesMap.delete(id);
      }
      for (const c of this.connectors()) {
        const attached = [c.from, c.to].some((e) => isBlockEnd(e) && set.has(e.block));
        if (attached) {
          this.connectorsMap.delete(c.id);
        }
      }
    });
  }

  /**
   * Copies blocks (with props, text and parent link), strokes and the selected connectors
   * between copied blocks; a parent that is copied too is remapped to its copy.
   */
  duplicate(ids: Iterable<string>, dx: number, dy: number): string[] {
    const set = new Set(ids);
    const created: string[] = [];
    const idMap = new Map<string, string>();
    this.transact(() => {
      let z = this.maxZ();
      for (const id of set) {
        const b = this.getBlock(id);
        if (b) {
          const copy = this.addBlock({
            type: b.type,
            x: b.x + dx,
            y: b.y + dy,
            w: b.w,
            h: b.h,
            rotation: b.rotation,
            props: this.cloneProps(id),
            text: b.hasText ? this.textOf(id) : undefined,
            parent: b.parent,
          });
          this.blocksMap.get(copy)?.set('z', ++z);
          idMap.set(id, copy);
          created.push(copy);
          continue;
        }
        const s = this.getStroke(id);
        if (s) {
          created.push(this.addStroke(movePoints(s.points, dx, dy), { ...s.style }));
        }
      }
      // a copy inside a copied frame belongs to the frame's copy; otherwise to the same frame
      for (const [original, copy] of idMap) {
        const parent = this.getBlock(original)?.parent;
        const mapped = parent ? idMap.get(parent) : undefined;
        if (mapped) {
          this.blocksMap.get(copy)?.set('parent', mapped);
        }
      }
      for (const c of this.connectors()) {
        if (!set.has(c.id)) {
          continue;
        }
        const from = remapEnd(c.from, idMap, dx, dy);
        const to = remapEnd(c.to, idMap, dx, dy);
        if (from && to) {
          created.push(this.addConnector(from, to, { ...c.style }, c.label));
        }
      }
    });
    return created;
  }

  // ---- connectors ----------------------------------------------------------------------------

  connectorIds(): string[] {
    return Array.from(this.connectorsMap.keys());
  }

  connectors(): ConnectorData[] {
    return this.connectorIds().flatMap((id) => this.getConnector(id) ?? []);
  }

  getConnector(id: string): ConnectorData | undefined {
    const m = this.connectorsMap.get(id);
    if (!m) {
      return undefined;
    }
    const style = (m.get('style') as Partial<ConnectorStyle> | undefined) ?? {};
    return {
      id,
      from: (m.get('from') as ConnectorEnd | undefined) ?? { x: 0, y: 0 },
      to: (m.get('to') as ConnectorEnd | undefined) ?? { x: 0, y: 0 },
      style: { ...DEFAULT_CONNECTOR_STYLE, ...style },
      label: str(m.get('label'), ''),
    };
  }

  addConnector(
    from: ConnectorEnd,
    to: ConnectorEnd,
    style: Partial<ConnectorStyle> = {},
    label = '',
  ): string {
    const id = crypto.randomUUID();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      this.connectorsMap.set(id, m);
      m.set('id', id);
      m.set('from', from);
      m.set('to', to);
      m.set('style', { ...DEFAULT_CONNECTOR_STYLE, ...style });
      m.set('label', label);
    });
    return id;
  }

  updateConnector(
    id: string,
    patch: { from?: ConnectorEnd; to?: ConnectorEnd; label?: string },
  ): void {
    const m = this.connectorsMap.get(id);
    if (!m) {
      return;
    }
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) {
          m.set(k, v);
        }
      }
    });
  }

  setConnectorStyle(id: string, patch: Partial<ConnectorStyle>): void {
    const m = this.connectorsMap.get(id);
    if (m) {
      this.transact(() => m.set('style', { ...(m.get('style') as object), ...patch }));
    }
  }

  // ---- strokes -------------------------------------------------------------------------------

  strokeIds(): string[] {
    return Array.from(this.strokesMap.keys());
  }

  strokes(): StrokeData[] {
    return this.strokeIds().flatMap((id) => this.getStroke(id) ?? []);
  }

  getStroke(id: string): StrokeData | undefined {
    const m = this.strokesMap.get(id);
    if (!m) {
      return undefined;
    }
    return {
      id,
      points: (m.get('points') as number[] | undefined) ?? [],
      style: { color: '#0f172a', size: 4, ...(m.get('style') as Partial<StrokeStyle> | undefined) },
    };
  }

  addStroke(points: number[], style: StrokeStyle): string {
    const id = crypto.randomUUID();
    this.transact(() => {
      const m = new Y.Map<unknown>();
      this.strokesMap.set(id, m);
      m.set('id', id);
      m.set('points', points);
      m.set('style', style);
    });
    return id;
  }

  setStrokeStyle(id: string, patch: Partial<StrokeStyle>): void {
    const m = this.strokesMap.get(id);
    if (m) {
      this.transact(() => m.set('style', { ...(m.get('style') as object), ...patch }));
    }
  }

  // ---- anchors -------------------------------------------------------------------------------

  /** The point where a connector end sits. `towards` decides the side for the `auto` anchor. */
  resolveEnd(end: ConnectorEnd, towards: Point): Point | undefined {
    if (!isBlockEnd(end)) {
      return end;
    }
    const b = this.getBlock(end.block);
    return b ? anchorPoint(b, end.anchor, towards) : undefined;
  }

  // ---- change notification -------------------------------------------------------------------

  private onTransaction(tr: Y.Transaction): void {
    const change: BoardChange = {
      blocks: new Set<string>(),
      connectors: new Set<string>(),
      strokes: new Set<string>(),
      meta: false,
      local: tr.origin === LOCAL_ORIGIN,
    };
    const roots: [AnyType, Set<string>][] = [
      [this.blocksMap, change.blocks as Set<string>],
      [this.connectorsMap, change.connectors as Set<string>],
      [this.strokesMap, change.strokes as Set<string>],
    ];
    for (const [type, keys] of tr.changed) {
      if ((type as AnyType) === this.meta) {
        (change as { meta: boolean }).meta = true;
        continue;
      }
      for (const [root, ids] of roots) {
        if (type === root) {
          for (const key of keys) {
            if (key !== null) {
              ids.add(key);
            }
          }
          break;
        }
        const id = idUnder(type, root);
        if (id !== undefined) {
          ids.add(id);
          break;
        }
      }
    }
    for (const id of change.blocks) {
      this.blockCache.delete(id);
    }
    if (change.blocks.size || change.connectors.size || change.strokes.size || change.meta) {
      for (const l of [...this.listeners]) {
        l(change);
      }
    }
  }
}

/** See `BoardDoc.blockShape`. */
export interface BlockShape {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  parent: string | null;
}

function shapeOf(id: string, m: Y.Map<unknown>): BlockShape {
  const parent = m.get('parent');
  return {
    id,
    type: str(m.get('type'), 'unknown'),
    x: num(m.get('x')),
    y: num(m.get('y')),
    w: num(m.get('w'), 100),
    h: num(m.get('h'), 100),
    z: num(m.get('z')),
    parent: typeof parent === 'string' ? parent : null,
  };
}

/** The key under `root` of the entry that contains `type`, or undefined if it is not inside `root`. */
function idUnder(type: AnyType, root: AnyType): string | undefined {
  let current: AnyType = type;
  while (current._item) {
    if (current._item.parent === root) {
      return current._item.parentSub ?? undefined;
    }
    current = current._item.parent as AnyType;
  }
  return undefined;
}

function remapEnd(
  end: ConnectorEnd,
  idMap: Map<string, string>,
  dx: number,
  dy: number,
): ConnectorEnd | undefined {
  if (isBlockEnd(end)) {
    const mapped = idMap.get(end.block);
    return mapped ? { block: mapped, anchor: end.anchor } : undefined;
  }
  return { x: end.x + dx, y: end.y + dy };
}

export function movePoints(points: number[], dx: number, dy: number): number[] {
  const out = points.slice();
  for (let i = 0; i + 1 < out.length; i += 3) {
    out[i] = (out[i] ?? 0) + dx;
    out[i + 1] = (out[i + 1] ?? 0) + dy;
  }
  return out;
}

/** Midpoint of a block side; for `auto` the side that faces `towards`. */
export function anchorPoint(b: Rect, anchor: Anchor, towards: Point): Point {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  let side = anchor;
  if (side === 'auto') {
    const dx = (towards.x - cx) / (b.w / 2 || 1);
    const dy = (towards.y - cy) / (b.h / 2 || 1);
    side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  }
  switch (side) {
    case 'top':
      return { x: cx, y: b.y };
    case 'bottom':
      return { x: cx, y: b.y + b.h };
    case 'left':
      return { x: b.x, y: cy };
    default:
      return { x: b.x + b.w, y: cy };
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
