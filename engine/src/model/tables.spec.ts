import * as Y from 'yjs';

import { BoardDoc } from './board-doc.js';
import { FRAME_TITLE_HEIGHT, assignParents } from './frames.js';
import {
  TABLE_DEFAULTS,
  TABLE_LIMITS,
  addColumn,
  addRow,
  cellOf,
  cellsToTables,
  createTable,
  normalizeTables,
  parseCellProps,
  parseTableProps,
  removeColumn,
  removeRow,
  resizeCell,
  resizeTable,
  tableOf,
} from './tables.js';

describe('tables', () => {
  let board: BoardDoc;
  beforeEach(() => (board = new BoardDoc()));
  afterEach(() => board.destroy());

  /** A 3 x 3 table with its top-left corner at 0,0. */
  function table(): string {
    const w = 3 * TABLE_DEFAULTS.colWidth;
    const h = FRAME_TITLE_HEIGHT + TABLE_DEFAULTS.headerHeight + 2 * TABLE_DEFAULTS.rowHeight;
    return createTable(board, { x: w / 2, y: h / 2 });
  }
  const cell = (t: string, row: number, col: number): string =>
    tableOf(board, t)?.cells[row]?.[col] ?? 'missing';
  /** A card dropped into a cell (by the frame rules). */
  function card(t: string, row: number, col: number): string {
    const c = board.getBlock(cell(t, row, col));
    const id = board.addBlock({
      type: 'core.sticky',
      x: (c?.x ?? 0) + 40,
      y: (c?.y ?? 0) + 40,
      w: 50,
      h: 50,
    });
    assignParents(board, [id]);
    return id;
  }

  describe('props', () => {
    it('when table props are well-formed then they are read, otherwise refused', () => {
      const good = { rows: 2, cols: 1, colWidths: [100], rowHeights: [60, 60] };

      expect(parseTableProps(good), 'good').toEqual(good);
      expect(parseTableProps({ ...good, rows: 1.5 }), 'fraction').toBeUndefined();
      expect(parseTableProps({ ...good, rows: 0 }), 'zero').toBeUndefined();
      expect(
        parseTableProps({ ...good, cols: TABLE_LIMITS.maxCols + 1 }),
        'too many',
      ).toBeUndefined();
      expect(parseTableProps({ ...good, colWidths: [100, 100] }), 'lengths').toBeUndefined();
      expect(parseTableProps({ ...good, rowHeights: [60, 1] }), 'too small').toBeUndefined();
      expect(parseTableProps({ ...good, colWidths: [Infinity] }), 'not finite').toBeUndefined();
      expect(parseTableProps([good]), 'not an object').toBeUndefined();
      expect(parseCellProps({ row: 0, col: 2 }), 'cell').toEqual({ row: 0, col: 2 });
      expect(parseCellProps({ row: -1, col: 0 }), 'negative').toBeUndefined();
      expect(parseCellProps({ row: '0', col: 0 }), 'string').toBeUndefined();
      expect(parseCellProps(null), 'null').toBeUndefined();
    });
  });

  describe('createTable', () => {
    it('when a table is created then it is a frame with a header row and a grid of cell frames', () => {
      const t = table();

      const layout = tableOf(board, t);
      expect(layout?.rows, 'rows').toBe(3);
      expect(layout?.cols, 'cols').toBe(3);
      expect(board.textOf(t), 'title').toBe('Table');
      expect(board.textOf(cell(t, 0, 1)), 'header title').toBe('Column 2');
      expect(board.textOf(cell(t, 1, 1)), 'body cells start empty').toBe('');
      expect(board.getBlock(cell(t, 1, 2)), 'grid position').toMatchObject({
        x: 2 * TABLE_DEFAULTS.colWidth,
        y: FRAME_TITLE_HEIGHT + TABLE_DEFAULTS.headerHeight,
        w: TABLE_DEFAULTS.colWidth,
        h: TABLE_DEFAULTS.rowHeight,
        parent: t,
      });
      expect(cellOf(board, cell(t, 2, 0)), 'cell of').toMatchObject({ row: 2, col: 0 });
      expect(cellsToTables(board, [cell(t, 1, 1), 'other']), 'cells become their table').toEqual([
        t,
        'other',
      ]);
    });

    it('when a card is dropped into a cell then it belongs to the cell', () => {
      const t = table();

      const id = card(t, 1, 2);

      expect(board.getBlock(id)?.parent, 'cell').toBe(cell(t, 1, 2));
    });
  });

  describe('structure', () => {
    it('when a cell is missing, doubled or out of range then the table is plain frames', () => {
      const t = table();
      const doubled = table();
      const outOfRange = table();
      board.deleteItems([cell(t, 2, 2)]);
      board.setProp(cell(doubled, 1, 1), 'cell', { row: 1, col: 0 });
      board.setProp(cell(outOfRange, 1, 1), 'cell', { row: 1, col: 7 });

      expect(tableOf(board, t), 'missing').toBeUndefined();
      expect(tableOf(board, doubled), 'doubled').toBeUndefined();
      expect(tableOf(board, outOfRange), 'out of range').toBeUndefined();
      expect(cellOf(board, cell(table(), 0, 0)), 'an intact one still works').toBeDefined();
      expect(addRow(board, t), 'no table behaviour').toBe(false);
    });

    it('when two people add a row and a column at once then the merged table degrades to frames', () => {
      const a = new BoardDoc(new Y.Doc());
      const b = new BoardDoc(new Y.Doc());
      const t = createTable(a, { x: 0, y: 0 });
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

      addRow(a, t);
      addColumn(b, t);
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));

      expect(tableOf(a, t), 'a: plain frames').toBeUndefined();
      expect(tableOf(b, t), 'b: the same').toBeUndefined();
      expect(a.blocks().length, 'nothing lost: 1 + 9 + 3 + 3 frames').toBe(16);
      a.destroy();
      b.destroy();
    });
  });

  describe('rows and columns', () => {
    it('when a row is added below the header then the rows below move down with their cards', () => {
      const t = table();
      const below = card(t, 1, 0);
      const y = board.getBlock(below)?.y ?? 0;

      expect(addRow(board, t, 0), 'added').toBe(true);

      const layout = tableOf(board, t);
      expect(layout?.rows, 'rows').toBe(4);
      expect(board.getBlock(below)?.parent, 'card in the same cell').toBe(layout?.cells[2]?.[0]);
      expect(board.getBlock(below)?.y, 'moved down with it').toBe(y + TABLE_DEFAULTS.rowHeight);
      expect(board.getBlock(t)?.h, 'table grew').toBe(
        FRAME_TITLE_HEIGHT + TABLE_DEFAULTS.headerHeight + 3 * TABLE_DEFAULTS.rowHeight,
      );
    });

    it('when a column is added then the columns to its right move with their cards', () => {
      const t = table();
      const right = card(t, 1, 2);
      const x = board.getBlock(right)?.x ?? 0;

      addColumn(board, t, 0);

      const layout = tableOf(board, t);
      expect(layout?.cols, 'cols').toBe(4);
      expect(board.getBlock(right)?.x, 'moved right').toBe(x + TABLE_DEFAULTS.colWidth);
      expect(board.textOf(layout?.cells[0]?.[1] ?? ''), 'a new header cell').toBe('Column 2');
    });

    it('when a row is removed then its cards stay where they are, now in the table frame', () => {
      const t = table();
      const inRow = card(t, 1, 1);
      const before = board.getBlock(inRow);

      expect(removeRow(board, t, 1), 'removed').toBe(true);

      expect(tableOf(board, t)?.rows, 'rows').toBe(2);
      expect(board.getBlock(inRow), 'kept in place').toMatchObject({
        x: before?.x,
        y: before?.y,
        parent: t,
      });
      expect(removeRow(board, t, 0), 'never the header').toBe(false);
    });

    it('when a column is removed then the last one cannot go', () => {
      const t = table();
      const inCol = card(t, 2, 0);

      removeColumn(board, t, 0);
      removeColumn(board, t, 0);

      expect(board.getBlock(inCol)?.parent, 'card to the table').toBe(t);
      expect(tableOf(board, t)?.cols, 'one left').toBe(1);
      expect(removeColumn(board, t, 0), 'not the last').toBe(false);
      expect(tableOf(board, t)?.colWidths, 'widths follow').toEqual([TABLE_DEFAULTS.colWidth]);
    });

    it('when the table is full then no more rows or columns are added', () => {
      const t = createTable(board, { x: 0, y: 0 }, TABLE_LIMITS.maxRows, TABLE_LIMITS.maxCols);

      expect(addRow(board, t), 'rows').toBe(false);
      expect(addColumn(board, t), 'cols').toBe(false);
    });
  });

  describe('resizing', () => {
    it('when a cell is resized then its column and row change and the cells after it move', () => {
      const t = table();
      const inCell = card(t, 1, 0);
      const right = card(t, 1, 1);
      const before = { own: board.getBlock(inCell), right: board.getBlock(right) };

      expect(resizeCell(board, cell(t, 1, 0), { w: 300, h: 10 }), 'resized').toBe(true);

      const layout = tableOf(board, t);
      expect(layout?.colWidths[0], 'column width').toBe(300);
      expect(layout?.rowHeights[1], 'row height at its minimum').toBe(TABLE_LIMITS.minRowHeight);
      expect(board.getBlock(inCell)?.x, 'own card does not move').toBe(before.own?.x);
      expect(board.getBlock(right)?.x, 'next column moved with its card').toBe(
        (before.right?.x ?? 0) + 60,
      );
      expect(resizeCell(board, t, { w: 1, h: 1 }), 'not a cell').toBe(false);
    });

    it('when the table is resized then rows and columns scale and the grid follows', () => {
      const t = table();

      resizeTable(board, t, { x: 100, y: 0, w: 1440, h: board.getBlock(t)?.h ?? 0 });

      expect(tableOf(board, t)?.colWidths, 'doubled').toEqual([480, 480, 480]);
      expect(board.getBlock(cell(t, 0, 0))?.x, 'grid moved with the table').toBe(100);
      expect(resizeTable(board, cell(t, 0, 0), { x: 0, y: 0, w: 1, h: 1 }), 'not a table').toBe(
        false,
      );
    });
  });

  describe('normalizeTables', () => {
    const fileBlock = (
      id: string,
      parent: string | null,
      props: Record<string, unknown>,
    ): { id: string; type: string; parent: string | null; props: Record<string, unknown> } => ({
      id,
      type: 'core.frame',
      parent,
      props,
    });

    it('when the file holds an intact table then its props stay, a broken one becomes frames', () => {
      const tableProps = { rows: 1, cols: 2, colWidths: [100, 100], rowHeights: [60] };
      const blocks = [
        fileBlock('t', null, { table: tableProps }),
        fileBlock('a', 't', { cell: { row: 0, col: 0 } }),
        fileBlock('b', 't', { cell: { row: 0, col: 1 } }),
        fileBlock('broken', null, { table: tableProps }),
        fileBlock('c', 'broken', { cell: { row: 0, col: 0 } }),
        fileBlock('stray', null, { cell: { row: 0, col: 0 } }),
      ];

      normalizeTables(blocks);

      expect(blocks[0]?.props['table'], 'intact').toEqual(tableProps);
      expect(blocks[1]?.props['cell'], 'its cell').toEqual({ row: 0, col: 0 });
      expect(blocks[3]?.props['table'], 'broken: no table').toBeUndefined();
      expect(blocks[4]?.props['cell'], 'its cell: plain frame').toBeUndefined();
      expect(blocks[5]?.props['cell'], 'a cell without a table').toBeUndefined();
    });
  });
});
