import * as Y from 'yjs';

import { BoardDoc } from './board-doc.js';
import { FRAME_TITLE_HEIGHT, FRAME_TYPE, FrameTree, isFrame } from './frames.js';
import { Point, Rect } from './types.js';

/**
 * Tables (Georg: "many frames inside a parent frame"): a table is a `core.frame` whose props hold
 * `table = { rows, cols, colWidths, rowHeights }`, and whose children include one cell frame per
 * row and column with `cell = { row, col }`. Row 0 is the header row. Cells are ordinary frames,
 * so a card dropped into a cell becomes the cell's child by the frame rules, moving the table
 * moves everything, and copy/paste/import keep it.
 *
 * Why not a `core.table` type: every frame rule (membership, z-order, move, delete, clipboard,
 * validation) then applies unchanged, and a broken table is simply frames.
 *
 * The structure is checked whenever it is used (`tableOf`): exactly one cell per row and column,
 * sizes and counts in range. Anything else - a concurrent "add row" and "add column" by two
 * people, a hand-written file - makes the table plain frames again: no table behaviour, nothing
 * crashes, nothing is lost. Import and paste strip table and cell props that do not form a
 * table (`normalizeTables`).
 *
 * Layout: the table frame has its title strip on top; the grid fills the rest. Cell positions
 * always follow from the table's position and `colWidths`/`rowHeights` (`layoutTable`); a cell
 * that moves takes its content along, a cell that only changes size does not move it.
 */

export const TABLE_LIMITS = {
  maxRows: 50,
  maxCols: 20,
  minColWidth: 80,
  minRowHeight: 48,
  maxSize: 5_000,
} as const;

export const TABLE_DEFAULTS = {
  rows: 3,
  cols: 3,
  colWidth: 240,
  headerHeight: 64,
  rowHeight: 200,
  headerFill: '#f1f5f9',
} as const;

export interface TableProps {
  rows: number;
  cols: number;
  colWidths: number[];
  rowHeights: number[];
}

export interface CellProps {
  row: number;
  col: number;
}

/** A checked table: its props and the id of each cell, `cells[row][col]`. */
export interface TableLayout extends TableProps {
  id: string;
  cells: string[][];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function count(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined;
}

function sizes(v: unknown, length: number, min: number): number[] | undefined {
  return Array.isArray(v) &&
    v.length === length &&
    v.every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= TABLE_LIMITS.maxSize,
    )
    ? (v as number[]).slice()
    : undefined;
}

/** `props.table` if it is well-formed, else undefined. Reads only own, known keys. */
export function parseTableProps(v: unknown): TableProps | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const rows = count(v['rows'], TABLE_LIMITS.maxRows);
  const cols = count(v['cols'], TABLE_LIMITS.maxCols);
  if (rows === undefined || cols === undefined) {
    return undefined;
  }
  const colWidths = sizes(v['colWidths'], cols, TABLE_LIMITS.minColWidth);
  const rowHeights = sizes(v['rowHeights'], rows, TABLE_LIMITS.minRowHeight);
  return colWidths && rowHeights ? { rows, cols, colWidths, rowHeights } : undefined;
}

/** `props.cell` if it is well-formed (row and column inside the limits), else undefined. */
export function parseCellProps(v: unknown): CellProps | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const { row, col } = v;
  const ok = (n: unknown, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < max;
  return ok(row, TABLE_LIMITS.maxRows) && ok(col, TABLE_LIMITS.maxCols) ? { row, col } : undefined;
}

/**
 * The cell grid from a table's props and the cell props of its frame children, or undefined if
 * they do not form exactly one cell per row and column.
 */
export function cellGrid(
  table: TableProps,
  children: readonly { id: string; cell: CellProps | undefined }[],
): string[][] | undefined {
  const grid: (string | undefined)[][] = Array.from({ length: table.rows }, () =>
    Array.from({ length: table.cols }, () => undefined),
  );
  let found = 0;
  for (const child of children) {
    const c = child.cell;
    if (!c) {
      continue;
    }
    const row = grid[c.row];
    if (!row || c.col >= table.cols || row[c.col] !== undefined) {
      return undefined;
    }
    row[c.col] = child.id;
    found++;
  }
  return found === table.rows * table.cols ? (grid as string[][]) : undefined;
}

function propOf(board: BoardDoc, id: string, key: string): unknown {
  const props = board.blocksMap.get(id)?.get('props');
  if (!(props instanceof Y.Map)) {
    return undefined;
  }
  const value = (props as Y.Map<unknown>).get(key);
  return value instanceof Y.AbstractType ? undefined : value;
}

/** The checked table of a frame, or undefined if it is no (intact) table. */
export function tableOf(
  board: BoardDoc,
  id: string,
  tree = new FrameTree(board),
): TableLayout | undefined {
  if (!isFrame(board.blockShape(id))) {
    return undefined;
  }
  const props = parseTableProps(propOf(board, id, 'table'));
  if (!props) {
    return undefined;
  }
  const children = tree
    .children(id)
    .filter((c) => isFrame(board.blockShape(c)))
    .map((c) => ({ id: c, cell: parseCellProps(propOf(board, c, 'cell')) }));
  const cells = cellGrid(props, children);
  return cells ? { ...props, id, cells } : undefined;
}

/** For a cell of an intact table: the table and the cell's place, else undefined. */
export function cellOf(
  board: BoardDoc,
  id: string,
  tree = new FrameTree(board),
): { table: TableLayout; row: number; col: number } | undefined {
  const cell = parseCellProps(propOf(board, id, 'cell'));
  const parent = tree.parent(id);
  if (!cell || parent === null) {
    return undefined;
  }
  const table = tableOf(board, parent, tree);
  return table?.cells[cell.row]?.[cell.col] === id ? { table, ...cell } : undefined;
}

/** Cells of intact tables are replaced by their table (a cell never moves or copies alone). */
export function cellsToTables(board: BoardDoc, ids: readonly string[]): string[] {
  const tree = new FrameTree(board);
  const out = new Set<string>();
  for (const id of ids) {
    out.add(cellOf(board, id, tree)?.table.id ?? id);
  }
  return [...out];
}

/** True for a cell of an intact table (cells are not deleted one by one). */
export function isTableCell(board: BoardDoc, id: string, tree = new FrameTree(board)): boolean {
  return cellOf(board, id, tree) !== undefined;
}

function sum(values: readonly number[], end = values.length): number {
  return values.slice(0, end).reduce((a, b) => a + b, 0);
}

/** Where a cell goes in a table at (x, y). */
export function cellRect(table: TableProps, origin: Point, row: number, col: number): Rect {
  return {
    x: origin.x + sum(table.colWidths, col),
    y: origin.y + FRAME_TITLE_HEIGHT + sum(table.rowHeights, row),
    w: table.colWidths[col] ?? TABLE_LIMITS.minColWidth,
    h: table.rowHeights[row] ?? TABLE_LIMITS.minRowHeight,
  };
}

function setRect(board: BoardDoc, id: string, r: Rect): void {
  board.setGeometry(id, r);
}

/**
 * Puts the table frame and every cell where the props say, in one transaction: a cell that moves
 * takes what is inside it along (so cards stay in their cell when a column to the left grows); a
 * size change alone moves nothing inside.
 */
export function layoutTable(board: BoardDoc, layout: TableLayout, origin?: Point): void {
  const table = board.blockShape(layout.id);
  if (!table) {
    return;
  }
  const at = origin ?? { x: table.x, y: table.y };
  board.transact(() => {
    setRect(board, layout.id, {
      ...at,
      w: sum(layout.colWidths),
      h: FRAME_TITLE_HEIGHT + sum(layout.rowHeights),
    });
    const tree = new FrameTree(board);
    layout.cells.forEach((row, r) =>
      row.forEach((cellId, c) => {
        const now = board.blockShape(cellId);
        const next = cellRect(layout, at, r, c);
        if (!now) {
          return;
        }
        const dx = next.x - now.x;
        const dy = next.y - now.y;
        if (dx !== 0 || dy !== 0) {
          board.moveItems(tree.descendants(cellId), dx, dy);
        }
        setRect(board, cellId, next);
      }),
    );
  });
}

function writeTableProps(board: BoardDoc, id: string, props: TableProps): void {
  board.setProp(id, 'table', {
    rows: props.rows,
    cols: props.cols,
    colWidths: props.colWidths,
    rowHeights: props.rowHeights,
  });
}

function addCell(board: BoardDoc, table: string, row: number, col: number, rect: Rect): string {
  return board.addBlock({
    type: FRAME_TYPE,
    ...rect,
    parent: table,
    props: { fill: row === 0 ? TABLE_DEFAULTS.headerFill : '#ffffff', cell: { row, col } },
    text: row === 0 ? `Column ${col + 1}` : '',
  });
}

/**
 * A new table centred on `at` with a header row: one transaction (one undo step with the
 * caller's stopCapturing). Returns the table frame's id.
 */
export function createTable(
  board: BoardDoc,
  at: Point,
  rows: number = TABLE_DEFAULTS.rows,
  cols: number = TABLE_DEFAULTS.cols,
): string {
  const props: TableProps = {
    rows,
    cols,
    colWidths: Array.from({ length: cols }, () => TABLE_DEFAULTS.colWidth),
    rowHeights: Array.from({ length: rows }, (_, r) =>
      r === 0 ? TABLE_DEFAULTS.headerHeight : TABLE_DEFAULTS.rowHeight,
    ),
  };
  const w = sum(props.colWidths);
  const h = FRAME_TITLE_HEIGHT + sum(props.rowHeights);
  const origin = { x: at.x - w / 2, y: at.y - h / 2 };
  let id = '';
  board.transact(() => {
    id = board.addBlock({
      type: FRAME_TYPE,
      ...origin,
      w,
      h,
      props: { fill: '#ffffff', table: { ...props } },
      text: 'Table',
    });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        addCell(board, id, r, c, cellRect(props, origin, r, c));
      }
    }
  });
  return id;
}

/** Inserts a row after `after` (-1: at the top, below nothing; default: at the end). */
export function addRow(board: BoardDoc, tableId: string, after?: number): boolean {
  const t = tableOf(board, tableId);
  if (!t || t.rows >= TABLE_LIMITS.maxRows) {
    return false;
  }
  const at = Math.max(1, Math.min(t.rows, (after ?? t.rows - 1) + 1)); // never above the header
  board.transact(() => {
    for (const [r, row] of t.cells.entries()) {
      if (r >= at) {
        row.forEach((id, c) => board.setProp(id, 'cell', { row: r + 1, col: c }));
      }
    }
    const props: TableProps = {
      ...t,
      rows: t.rows + 1,
      rowHeights: [
        ...t.rowHeights.slice(0, at),
        TABLE_DEFAULTS.rowHeight,
        ...t.rowHeights.slice(at),
      ],
    };
    const origin = { x: board.blockShape(tableId)?.x ?? 0, y: board.blockShape(tableId)?.y ?? 0 };
    const added = Array.from({ length: t.cols }, (_, c) =>
      addCell(board, tableId, at, c, cellRect(props, origin, at, c)),
    );
    writeTableProps(board, tableId, props);
    const cells = [...t.cells.slice(0, at), added, ...t.cells.slice(at)];
    layoutTable(board, { ...props, id: tableId, cells });
  });
  return true;
}

/** Inserts a column after `after` (default: at the end). */
export function addColumn(board: BoardDoc, tableId: string, after?: number): boolean {
  const t = tableOf(board, tableId);
  if (!t || t.cols >= TABLE_LIMITS.maxCols) {
    return false;
  }
  const at = Math.max(0, Math.min(t.cols, (after ?? t.cols - 1) + 1));
  board.transact(() => {
    t.cells.forEach((row, r) =>
      row.forEach((id, c) => {
        if (c >= at) {
          board.setProp(id, 'cell', { row: r, col: c + 1 });
        }
      }),
    );
    const props: TableProps = {
      ...t,
      cols: t.cols + 1,
      colWidths: [...t.colWidths.slice(0, at), TABLE_DEFAULTS.colWidth, ...t.colWidths.slice(at)],
    };
    const origin = { x: board.blockShape(tableId)?.x ?? 0, y: board.blockShape(tableId)?.y ?? 0 };
    const cells = t.cells.map((row, r) => [
      ...row.slice(0, at),
      addCell(board, tableId, r, at, cellRect(props, origin, r, at)),
      ...row.slice(at),
    ]);
    writeTableProps(board, tableId, props);
    layoutTable(board, { ...props, id: tableId, cells });
  });
  return true;
}

/**
 * Removes cells; what was inside them stays where it is and belongs to the table frame from now
 * on (nothing is deleted, so no confirmation is needed; dragging it re-homes it).
 */
function removeCells(board: BoardDoc, tableId: string, cells: readonly string[]): void {
  const tree = new FrameTree(board);
  for (const cell of cells) {
    for (const child of tree.children(cell)) {
      board.blocksMap.get(child)?.set('parent', tableId);
    }
  }
  board.deleteItems(cells);
}

/** Removes a body row (the header row stays; at least one row is left). */
export function removeRow(board: BoardDoc, tableId: string, row: number): boolean {
  const t = tableOf(board, tableId);
  if (!t || row < 1 || row >= t.rows) {
    return false;
  }
  board.transact(() => {
    removeCells(board, tableId, t.cells[row] ?? []);
    t.cells.forEach((cells, r) => {
      if (r > row) {
        cells.forEach((id, c) => board.setProp(id, 'cell', { row: r - 1, col: c }));
      }
    });
    const props: TableProps = {
      ...t,
      rows: t.rows - 1,
      rowHeights: t.rowHeights.filter((_, r) => r !== row),
    };
    writeTableProps(board, tableId, props);
    layoutTable(board, { ...props, id: tableId, cells: t.cells.filter((_, r) => r !== row) });
  });
  return true;
}

/** Removes a column (at least one is left). */
export function removeColumn(board: BoardDoc, tableId: string, col: number): boolean {
  const t = tableOf(board, tableId);
  if (!t || t.cols <= 1 || col < 0 || col >= t.cols) {
    return false;
  }
  board.transact(() => {
    removeCells(
      board,
      tableId,
      t.cells.map((row) => row[col] ?? ''),
    );
    t.cells.forEach((row, r) =>
      row.forEach((id, c) => {
        if (c > col) {
          board.setProp(id, 'cell', { row: r, col: c - 1 });
        }
      }),
    );
    const props: TableProps = {
      ...t,
      cols: t.cols - 1,
      colWidths: t.colWidths.filter((_, c) => c !== col),
    };
    writeTableProps(board, tableId, props);
    layoutTable(board, {
      ...props,
      id: tableId,
      cells: t.cells.map((row) => row.filter((_, c) => c !== col)),
    });
  });
  return true;
}

function clampSize(n: number, min: number): number {
  return Math.min(TABLE_LIMITS.maxSize, Math.max(min, Math.round(n)));
}

/** A cell was resized: its column takes the new width, its row the new height. */
export function resizeCell(
  board: BoardDoc,
  cellId: string,
  size: { w: number; h: number },
): boolean {
  const found = cellOf(board, cellId);
  if (!found) {
    return false;
  }
  const { table, row, col } = found;
  const props: TableProps = {
    ...table,
    colWidths: table.colWidths.map((w, c) =>
      c === col ? clampSize(size.w, TABLE_LIMITS.minColWidth) : w,
    ),
    rowHeights: table.rowHeights.map((h, r) =>
      r === row ? clampSize(size.h, TABLE_LIMITS.minRowHeight) : h,
    ),
  };
  board.transact(() => {
    writeTableProps(board, table.id, props);
    layoutTable(board, { ...props, id: table.id, cells: table.cells });
  });
  return true;
}

/** The table frame was resized: columns and rows scale to the new size, the grid follows. */
export function resizeTable(board: BoardDoc, tableId: string, rect: Rect): boolean {
  const t = tableOf(board, tableId);
  if (!t) {
    return false;
  }
  const fx = rect.w / sum(t.colWidths);
  const fy = Math.max(1, rect.h - FRAME_TITLE_HEIGHT) / sum(t.rowHeights);
  const props: TableProps = {
    ...t,
    colWidths: t.colWidths.map((w) => clampSize(w * fx, TABLE_LIMITS.minColWidth)),
    rowHeights: t.rowHeights.map((h) => clampSize(h * fy, TABLE_LIMITS.minRowHeight)),
  };
  board.transact(() => {
    writeTableProps(board, tableId, props);
    layoutTable(board, { ...props, id: tableId, cells: t.cells }, { x: rect.x, y: rect.y });
  });
  return true;
}

/**
 * For validated file content (import, paste): drops `table` and `cell` props that do not form
 * an intact table, so a broken structure arrives as plain frames. Mutates the given blocks.
 */
export function normalizeTables(
  blocks: { id: string; type: string; parent: string | null; props: Record<string, unknown> }[],
): void {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const children = new Map<string, typeof blocks>();
  for (const b of blocks) {
    if (b.parent !== null && b.type === FRAME_TYPE) {
      children.set(b.parent, [...(children.get(b.parent) ?? []), b]);
    }
  }
  const valid = new Set<string>();
  for (const b of blocks) {
    const props = b.type === FRAME_TYPE ? parseTableProps(b.props['table']) : undefined;
    const cells = (children.get(b.id) ?? []).map((c) => ({
      id: c.id,
      cell: parseCellProps(c.props['cell']),
    }));
    if (props && cellGrid(props, cells)) {
      valid.add(b.id);
      b.props['table'] = props;
      for (const c of cells) {
        const child = byId.get(c.id);
        if (child && c.cell) {
          child.props['cell'] = c.cell;
        }
      }
    }
  }
  for (const b of blocks) {
    if (!valid.has(b.id)) {
      delete b.props['table'];
    }
    if (b.parent === null || !valid.has(b.parent) || !parseCellProps(b.props['cell'])) {
      delete b.props['cell'];
    }
  }
}
