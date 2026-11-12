import * as Y from 'yjs';

import { BoardDoc } from '../model/board-doc';
import { safeColor } from '../presence';

export const KANBAN_TYPE = 'core.kanban';

/**
 * Limits of one kanban block. They hold for what this client writes and for `.drawboard`
 * imports (S5.5); a document written by a foreign client is read defensively (anything past the
 * limits is not shown).
 */
export const KANBAN_LIMITS = {
  maxColumns: 20,
  maxCards: 500,
  maxTitle: 200,
  maxColumnTitle: 100,
  maxAssignee: 64,
  maxPoints: 999,
} as const;

/** The fixed label palette: a card stores label keys only, never a colour (S5.2). */
export const KANBAN_LABELS = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  grey: '#64748b',
} as const;

export type KanbanLabel = keyof typeof KANBAN_LABELS;

export const KANBAN_LABEL_KEYS = Object.keys(KANBAN_LABELS) as readonly KanbanLabel[];

/** Own keys only: `constructor` or `__proto__` are no label (S5.5). */
export function isKanbanLabel(key: unknown): key is KanbanLabel {
  return typeof key === 'string' && Object.hasOwn(KANBAN_LABELS, key);
}

/** The colour of a label, through `safeColor` like every colour that reaches a style. */
export function labelColor(key: KanbanLabel): string {
  return safeColor(KANBAN_LABELS[key], '#64748b');
}

/** Ids of columns and cards: lowercase UUIDs as `crypto.randomUUID()` makes them. */
export const KANBAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A due date is a calendar day, no time and no zone. */
export const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDueDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DUE_DATE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export interface KanbanCard {
  readonly id: string;
  /** The column the card is shown in (an orphan of a deleted column shows in the first one). */
  readonly column: string;
  readonly order: number;
  readonly title: string;
  /** Display name of a board member, or null. Never a user id (S1.10: guests read the doc). */
  readonly assignee: string | null;
  /** `YYYY-MM-DD` or null. */
  readonly due: string | null;
  readonly labels: readonly KanbanLabel[];
  readonly points: number | null;
}

export interface KanbanColumn {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly cards: readonly KanbanCard[];
}

export interface KanbanState {
  readonly title: string;
  readonly columns: readonly KanbanColumn[];
}

export type CardPatch = Partial<Pick<KanbanCard, 'title' | 'assignee' | 'due' | 'points'>> & {
  labels?: readonly KanbanLabel[];
};

/** A card on its way into a new document: plain values, validated. */
export interface KanbanFileCard {
  id: string;
  column: string;
  order: number;
  title: string;
  assignee: string | null;
  due: string | null;
  labels: KanbanLabel[];
  points: number | null;
}

export interface KanbanFileColumn {
  id: string;
  title: string;
  order: number;
}

/** The `board.json` form of a kanban's props: lists instead of keyed maps, readable and stable. */
export interface KanbanFileProps {
  title: string;
  columns: KanbanFileColumn[];
  cards: KanbanFileCard[];
}

/*
 * Y.Doc schema (block props, architecture 3.3/3.10):
 *
 *   props: Y.Map
 *     title     string
 *     columns   Y.Map<columnId, Y.Map { title: string, order: number }>
 *     cards     Y.Map<cardId,   Y.Map { column: string, order: number, title: string,
 *                                       assignee: string | null, due: string | null,
 *                                       labels: Y.Map<label, true>, points: number | null }>
 *
 * One Y.Map per column and per card, keyed by id; the position is a field (`column` + a
 * fractional `order`), so moving a card or a column is two field writes, never a delete and
 * re-insert: concurrent moves cannot duplicate a card, and an edit of a card by someone else
 * survives a concurrent move. Labels are a map so two people toggling different labels at the
 * same time both win.
 */

type YMap = Y.Map<unknown>;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readPoints(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= KANBAN_LIMITS.maxPoints
    ? v
    : null;
}

function readLabels(v: unknown): KanbanLabel[] {
  if (!(v instanceof Y.Map)) {
    return [];
  }
  return KANBAN_LABEL_KEYS.filter((key) => (v as YMap).get(key) === true);
}

function byOrder<T extends { order: number; id: string }>(a: T, b: T): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Reads a kanban from its props map - defensively, because any editor of the board can write
 * anything there: unknown ids and wrong types are skipped, everything is cut to the limits.
 */
export function readKanban(props: YMap | undefined): KanbanState {
  const title = str(props?.get('title'), KANBAN_LIMITS.maxTitle);
  const columnsMap = props?.get('columns');
  const cardsMap = props?.get('cards');
  const columns: { id: string; title: string; order: number; cards: KanbanCard[] }[] = [];
  if (columnsMap instanceof Y.Map) {
    for (const [id, value] of (columnsMap as Y.Map<unknown>).entries()) {
      if (KANBAN_ID.test(id) && value instanceof Y.Map) {
        const m = value as YMap;
        columns.push({
          id,
          title: str(m.get('title'), KANBAN_LIMITS.maxColumnTitle),
          order: finiteOr(m.get('order'), 0),
          cards: [],
        });
      }
    }
  }
  columns.sort(byOrder);
  columns.splice(KANBAN_LIMITS.maxColumns);
  const byId = new Map(columns.map((c) => [c.id, c]));
  if (cardsMap instanceof Y.Map && columns.length > 0) {
    let count = 0;
    for (const [id, value] of (cardsMap as Y.Map<unknown>).entries()) {
      if (!KANBAN_ID.test(id) || !(value instanceof Y.Map)) {
        continue;
      }
      if (++count > KANBAN_LIMITS.maxCards) {
        break;
      }
      const m = value as YMap;
      const wanted = m.get('column');
      // a card whose column was deleted meanwhile (concurrently) is not lost: it shows first
      const column =
        (typeof wanted === 'string' ? byId.get(wanted) : undefined) ?? (columns[0] as never);
      const due = m.get('due');
      const assignee = m.get('assignee');
      column.cards.push({
        id,
        column: column.id,
        order: finiteOr(m.get('order'), 0),
        title: str(m.get('title'), KANBAN_LIMITS.maxTitle),
        assignee:
          typeof assignee === 'string' && assignee.trim() !== ''
            ? assignee.slice(0, KANBAN_LIMITS.maxAssignee)
            : null,
        due: isValidDueDate(due) ? due : null,
        labels: readLabels(m.get('labels')),
        points: readPoints(m.get('points')),
      });
    }
  }
  for (const column of columns) {
    column.cards.sort(byOrder);
  }
  return { title, columns };
}

/** A position strictly between two neighbours (either may be missing). */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) {
    return 1;
  }
  if (before === undefined) {
    return (after as number) - 1;
  }
  if (after === undefined) {
    return before + 1;
  }
  return (before + after) / 2;
}

function newCardMap(card: Omit<KanbanFileCard, 'id'>): YMap {
  const m = new Y.Map<unknown>();
  m.set('column', card.column);
  m.set('order', card.order);
  m.set('title', card.title);
  m.set('assignee', card.assignee);
  m.set('due', card.due);
  const labels = new Y.Map<unknown>();
  for (const label of card.labels) {
    labels.set(label, true);
  }
  m.set('labels', labels);
  m.set('points', card.points);
  return m;
}

function newColumnMap(title: string, order: number): YMap {
  const m = new Y.Map<unknown>();
  m.set('title', title);
  m.set('order', order);
  return m;
}

/** The props of a new kanban block: a title and three empty columns. */
export function newKanbanProps(
  title = 'Kanban',
  columns: readonly string[] = ['To do', 'In progress', 'Done'],
): Record<string, unknown> {
  const map = new Y.Map<unknown>();
  columns.forEach((name, i) => map.set(crypto.randomUUID(), newColumnMap(name, i + 1)));
  return { title, columns: map, cards: new Y.Map<unknown>() };
}

/** Validated `board.json` props → the values to put into a new props map. */
export function kanbanPropsToY(file: KanbanFileProps): Record<string, unknown> {
  const columns = new Y.Map<unknown>();
  for (const c of file.columns) {
    columns.set(c.id, newColumnMap(c.title, c.order));
  }
  const cards = new Y.Map<unknown>();
  for (const card of file.cards) {
    cards.set(card.id, newCardMap(card));
  }
  return { title: file.title, columns, cards };
}

/** A kanban's props map → its `board.json` form (what the board shows, in order). */
export function kanbanPropsToFile(props: YMap | undefined): KanbanFileProps {
  const state = readKanban(props);
  return {
    title: state.title,
    columns: state.columns.map((c) => ({ id: c.id, title: c.title, order: c.order })),
    cards: state.columns.flatMap((c) =>
      c.cards.map((card) => ({
        id: card.id,
        column: card.column,
        order: card.order,
        title: card.title,
        assignee: card.assignee,
        due: card.due,
        labels: [...card.labels],
        points: card.points,
      })),
    ),
  };
}

/**
 * The edits of one kanban block. Every method is one transaction with the board's local origin
 * (so the board's undo covers it) and one undo step of its own (`stopCapturing` around it).
 * Methods that would break a limit do nothing and return undefined/false.
 */
export class KanbanModel {
  constructor(
    private readonly board: BoardDoc,
    readonly blockId: string,
    private readonly stopCapturing: () => void = () => undefined,
  ) {}

  read(): KanbanState {
    return readKanban(this.props());
  }

  card(id: string): KanbanCard | undefined {
    for (const column of this.read().columns) {
      const card = column.cards.find((c) => c.id === id);
      if (card) {
        return card;
      }
    }
    return undefined;
  }

  setTitle(title: string): void {
    this.edit((props) => props.set('title', title.slice(0, KANBAN_LIMITS.maxTitle)));
  }

  addColumn(title: string): string | undefined {
    const columns = this.read().columns;
    if (columns.length >= KANBAN_LIMITS.maxColumns) {
      return undefined;
    }
    const id = crypto.randomUUID();
    const order = orderBetween(columns.at(-1)?.order, undefined);
    this.edit(() =>
      this.columnsMap().set(id, newColumnMap(title.slice(0, KANBAN_LIMITS.maxColumnTitle), order)),
    );
    return id;
  }

  renameColumn(id: string, title: string): void {
    const m = this.columnsMap(false)?.get(id);
    if (m instanceof Y.Map) {
      this.edit(() => m.set('title', title.slice(0, KANBAN_LIMITS.maxColumnTitle)));
    }
  }

  /** Moves a column to `index` (0 = first) among the others. */
  moveColumn(id: string, index: number): void {
    const m = this.columnsMap(false)?.get(id);
    if (!(m instanceof Y.Map)) {
      return;
    }
    const others = this.read().columns.filter((c) => c.id !== id);
    this.edit(() => place(m as YMap, others, index, (cid) => this.columnsMap(false)?.get(cid)));
  }

  /** Deletes a column with its cards. */
  deleteColumn(id: string): void {
    const state = this.read();
    const column = state.columns.find((c) => c.id === id);
    if (!column) {
      return;
    }
    this.edit(() => {
      for (const card of column.cards) {
        this.cardsMap().delete(card.id);
      }
      this.columnsMap().delete(id);
    });
  }

  addCard(columnId: string, title: string): string | undefined {
    const state = this.read();
    const column = state.columns.find((c) => c.id === columnId);
    const total = state.columns.reduce((n, c) => n + c.cards.length, 0);
    if (!column || total >= KANBAN_LIMITS.maxCards) {
      return undefined;
    }
    const id = crypto.randomUUID();
    const order = orderBetween(column.cards.at(-1)?.order, undefined);
    this.edit(() =>
      this.cardsMap().set(
        id,
        newCardMap({
          column: columnId,
          order,
          title: title.slice(0, KANBAN_LIMITS.maxTitle),
          assignee: null,
          due: null,
          labels: [],
          points: null,
        }),
      ),
    );
    return id;
  }

  /** Writes only the fields in `patch`, each only if it changed. */
  updateCard(id: string, patch: CardPatch): void {
    const m = this.cardsMap(false)?.get(id);
    if (!(m instanceof Y.Map)) {
      return;
    }
    const card = m as YMap;
    this.edit(() => {
      if (patch.title !== undefined) {
        setIfChanged(card, 'title', patch.title.slice(0, KANBAN_LIMITS.maxTitle));
      }
      if (patch.assignee !== undefined) {
        const name = patch.assignee?.trim().slice(0, KANBAN_LIMITS.maxAssignee) ?? '';
        setIfChanged(card, 'assignee', name === '' ? null : name);
      }
      if (patch.due !== undefined) {
        setIfChanged(card, 'due', isValidDueDate(patch.due) ? patch.due : null);
      }
      if (patch.points !== undefined) {
        setIfChanged(card, 'points', readPoints(patch.points));
      }
      if (patch.labels !== undefined) {
        let labels = card.get('labels');
        if (!(labels instanceof Y.Map)) {
          labels = new Y.Map<unknown>();
          card.set('labels', labels);
        }
        const map = labels as YMap;
        const wanted = new Set(patch.labels.filter(isKanbanLabel));
        for (const key of [...map.keys()]) {
          if (!wanted.has(key as KanbanLabel)) {
            map.delete(key);
          }
        }
        for (const key of wanted) {
          if (map.get(key) !== true) {
            map.set(key, true);
          }
        }
      }
    });
  }

  /** Moves a card into `columnId` at `index` among the cards there (0 = top). */
  moveCard(id: string, columnId: string, index: number): void {
    const m = this.cardsMap(false)?.get(id);
    const column = this.read().columns.find((c) => c.id === columnId);
    if (!(m instanceof Y.Map) || !column) {
      return;
    }
    const others = column.cards.filter((c) => c.id !== id);
    this.edit(() => {
      setIfChanged(m as YMap, 'column', columnId);
      place(m as YMap, others, index, (cid) => this.cardsMap(false)?.get(cid));
    });
  }

  /**
   * Takes a card out of the kanban and lets `make` create what replaces it on the canvas, in
   * the same transaction - one undo step brings the card back. Returns what `make` returned.
   */
  moveCardOut(id: string, make: (card: KanbanCard) => string): string | undefined {
    const card = this.card(id);
    if (!card) {
      return undefined;
    }
    let created: string | undefined;
    this.edit(() => {
      created = make(card);
      this.cardsMap().delete(id);
    });
    return created;
  }

  deleteCard(id: string): void {
    if (this.cardsMap(false)?.has(id)) {
      this.edit(() => this.cardsMap().delete(id));
    }
  }

  /** The props map of the block (undefined once the block is gone). */
  props(): YMap | undefined {
    const props = this.board.blocksMap.get(this.blockId)?.get('props');
    return props instanceof Y.Map ? (props as YMap) : undefined;
  }

  private columnsMap(create?: true): YMap;
  private columnsMap(create: false): YMap | undefined;
  private columnsMap(create = true): YMap | undefined {
    return this.child('columns', create);
  }

  private cardsMap(create?: true): YMap;
  private cardsMap(create: false): YMap | undefined;
  private cardsMap(create = true): YMap | undefined {
    return this.child('cards', create);
  }

  /** A map under the props; created (inside the running transaction) when missing. */
  private child(key: 'columns' | 'cards', create: boolean): YMap | undefined {
    const props = this.props();
    const existing = props?.get(key);
    if (existing instanceof Y.Map) {
      return existing as YMap;
    }
    if (!create || !props) {
      return undefined;
    }
    const map = new Y.Map<unknown>();
    props.set(key, map);
    return map;
  }

  private edit(fn: (props: YMap) => void): void {
    const props = this.props();
    if (!props) {
      return;
    }
    this.stopCapturing();
    this.board.transact(() => fn(props));
    this.stopCapturing();
  }
}

/** Smallest gap between two neighbours before the list gets whole numbers again. */
const MIN_GAP = 1e-9;

/**
 * Gives `item` an order that puts it at `index` among `others` (sorted, without the item).
 * Halving the gap runs out of precision after about 50 moves into the same spot; then the
 * others get whole numbers first - in the same transaction, so it stays one undo step.
 */
function place(
  item: YMap,
  others: readonly { id: string; order: number }[],
  index: number,
  mapOf: (id: string) => unknown,
): void {
  const at = Math.max(0, Math.min(index, others.length));
  let before: number | undefined = others[at - 1]?.order;
  let after: number | undefined = others[at]?.order;
  const crowded = others.some((o, i) => i > 0 && o.order - (others[i - 1]?.order ?? 0) < MIN_GAP);
  if (crowded || (before !== undefined && after !== undefined && after - before < MIN_GAP)) {
    others.forEach((o, i) => {
      const m = mapOf(o.id);
      if (m instanceof Y.Map) {
        (m as YMap).set('order', i + 1);
      }
    });
    before = at > 0 ? at : undefined;
    after = at < others.length ? at + 1 : undefined;
  }
  setIfChanged(item, 'order', orderBetween(before, after));
}

function setIfChanged(map: YMap, key: string, value: unknown): void {
  if (map.get(key) !== value) {
    map.set(key, value);
  }
}
