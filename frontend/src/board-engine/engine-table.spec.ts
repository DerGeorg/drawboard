import { parseBoardFile } from './io/board-file';
import { FRAME_TITLE_HEIGHT } from './model/frames';
import { TABLE_DEFAULTS, tableOf } from './model/tables';
import { TestEngine, createTestEngine } from './testing/helpers';

describe('BoardEngine tables', () => {
  let t: TestEngine;
  beforeEach(() => (t = createTestEngine()));
  afterEach(() => t.destroy());

  /** A 3 x 3 table from the table tool, top-left corner at 0,0 (one undo step). */
  function table(): string {
    const w = 3 * TABLE_DEFAULTS.colWidth;
    const h = FRAME_TITLE_HEIGHT + TABLE_DEFAULTS.headerHeight + 2 * TABLE_DEFAULTS.rowHeight;
    t.engine.setTool('table');
    t.click(w / 2, h / 2);
    t.engine.flush();
    return t.engine.selection.list()[0] ?? '';
  }
  const cell = (id: string, row: number, col: number): string =>
    tableOf(t.board, id)?.cells[row]?.[col] ?? 'missing';
  /** World point in the middle of a body cell, below its title strip. */
  function inCell(id: string, row: number, col: number): { x: number; y: number } {
    const c = t.board.getBlock(cell(id, row, col));
    return { x: (c?.x ?? 0) + (c?.w ?? 0) / 2, y: (c?.y ?? 0) + (c?.h ?? 0) / 2 + 20 };
  }

  describe('creating and moving', () => {
    it('when the table tool is used then a 3 x 3 table with a header row is created, selected, one undo step', () => {
      t.engine.stopCapturing();

      const id = table();

      expect(tableOf(t.board, id)?.rows, 'rows').toBe(3);
      expect(t.engine.tool, 'back to select').toBe('select');
      expect(t.engine.selectedTable(), 'selected table').toMatchObject({ id, rows: 3, cols: 3 });
      expect(t.key('g'), 'G is the shortcut').toBe(true);
      expect(t.engine.tool, 'table tool').toBe('table');
      t.engine.undo();
      expect(t.board.blocks().length, 'undone at once').toBe(0);
    });

    it('when a card is dragged into a cell then it sorts into that cell, and moves with the table', () => {
      const id = table();
      const card = t.board.addBlock({ type: 'core.sticky', x: 2000, y: 2000, w: 50, h: 50 });
      const target = inCell(id, 2, 1);

      t.drag({ x: 2025, y: 2025 }, target);
      expect(t.board.getBlock(card)?.parent, 'in the cell').toBe(cell(id, 2, 1));
      // drag the table by its title
      t.drag({ x: 100, y: 10 }, { x: 300, y: 110 });

      expect(t.board.getBlock(id)?.x, 'table moved').toBe(200);
      expect(t.board.getBlock(cell(id, 2, 1))?.x, 'cell moved').toBe(TABLE_DEFAULTS.colWidth + 200);
      expect(t.board.getBlock(card)?.x, 'card moved').toBe(target.x - 25 + 200);
    });

    it('when a cell is selected and dragged by its title then the whole table moves', () => {
      const id = table();
      const c = t.board.getBlock(cell(id, 1, 1));
      t.engine.selection.set([cell(id, 1, 1)]);

      t.drag(
        { x: (c?.x ?? 0) + 20, y: (c?.y ?? 0) + 10 },
        { x: (c?.x ?? 0) + 70, y: (c?.y ?? 0) + 10 },
      );

      expect(t.board.getBlock(id)?.x, 'table moved').toBe(50);
      expect(tableOf(t.board, id), 'still intact').toBeDefined();
    });

    it('when Delete is pressed on a cell then nothing goes, on the table everything goes', () => {
      const id = table();
      t.engine.selection.set([cell(id, 1, 1)]);

      t.key('Delete');
      expect(tableOf(t.board, id), 'intact').toBeDefined();
      t.engine.selection.set([id]);
      t.key('Delete');

      expect(t.board.blocks().length, 'all gone').toBe(0);
    });
  });

  describe('resizing and editing', () => {
    it('when a cell is resized by its handle then its column gets wider and the grid follows', () => {
      const id = table();
      const c = t.board.getBlock(cell(id, 1, 0));
      t.engine.selection.set([cell(id, 1, 0)]);
      t.engine.flush();

      t.drag(
        { x: (c?.x ?? 0) + (c?.w ?? 0), y: (c?.y ?? 0) + (c?.h ?? 0) / 2 },
        { x: (c?.x ?? 0) + (c?.w ?? 0) + 100, y: (c?.y ?? 0) + (c?.h ?? 0) / 2 },
      );

      expect(tableOf(t.board, id)?.colWidths, 'first column wider').toEqual([
        TABLE_DEFAULTS.colWidth + 100,
        TABLE_DEFAULTS.colWidth,
        TABLE_DEFAULTS.colWidth,
      ]);
      expect(t.board.getBlock(cell(id, 0, 1))?.x, 'header moved too').toBe(
        TABLE_DEFAULTS.colWidth + 100,
      );
    });

    it('when rows and columns are added and removed from a cell then each is one undo step', () => {
      const id = table();
      t.engine.selection.set([cell(id, 1, 1)]);
      t.engine.stopCapturing();

      expect(t.engine.selectedTable(), 'cell place').toMatchObject({ id, row: 1, col: 1 });
      t.engine.tableAddRow();
      t.engine.tableAddColumn();
      expect(tableOf(t.board, id), 'grown').toMatchObject({ rows: 4, cols: 4 });
      t.engine.undo();
      expect(tableOf(t.board, id)?.cols, 'column undone').toBe(3);
      t.engine.tableRemoveColumn();
      expect(tableOf(t.board, id)?.cols, 'column removed').toBe(2);
      expect(t.engine.selection.list(), 'removed cell: the table is selected').toEqual([id]);
      t.engine.tableRemoveRow();
      expect(tableOf(t.board, id)?.rows, 'last row removed').toBe(3);
    });
  });

  describe('removing', () => {
    it('when a table is removed keeping its contents then the cards stay and the frames go', () => {
      const id = table();
      const target = inCell(id, 1, 1);
      const card = t.engine.insertBlock({ type: 'core.sticky', at: target }) ?? '';
      expect(t.board.getBlock(card)?.parent, 'in a cell').toBe(cell(id, 1, 1));
      t.engine.selection.set([id]);

      expect(t.engine.selectedFrames(), 'the table counts as a frame').toEqual([id]);
      t.engine.removeSelectedFrames();

      expect(
        t.board.blocks().map((b) => b.id),
        'only the card',
      ).toEqual([card]);
      t.engine.selection.set([]);
    });

    it('when a cell is selected then it is not offered as a frame to remove', () => {
      const id = table();
      t.engine.selection.set([cell(id, 0, 0)]);

      expect(t.engine.selectedFrames(), 'none').toEqual([]);
    });
  });

  describe('clipboard and import', () => {
    it('when a cell is copied then the whole table is copied and pasted intact', () => {
      const id = table();
      t.engine.selection.set([cell(id, 1, 1)]);

      const content = t.engine.copySelection();
      t.engine.pointerMove(t.at(3000, 3000, { buttons: 0 }));
      t.engine.paste({ json: content?.json });

      const pasted = t.engine.selection
        .list()
        .find((b) => b !== id && tableOf(t.board, b) !== undefined);
      expect(pasted, 'a second intact table').toBeDefined();
      expect(t.board.blocks().length, '2 x (1 + 9)').toBe(20);
    });

    it('when a file holds a broken table then it imports as plain frames', () => {
      const frame = (id: string, parent: string | null, props: Record<string, unknown>) => ({
        id,
        type: 'core.frame',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        parent,
        props,
        text: '',
      });
      const file = parseBoardFile({
        schemaVersion: 1,
        blocks: [
          frame('t', null, {
            table: { rows: 1, cols: 2, colWidths: [100, 100], rowHeights: [60] },
          }),
          frame('a', 't', { cell: { row: 0, col: 0 } }),
          frame('b', 't', { cell: { row: 0, col: 0 } }),
          frame('x', null, { table: 'nonsense', cell: { row: 'a' } }),
        ],
      });

      expect(
        file.blocks.map((b) => b.props),
        'no table, no cells',
      ).toEqual([{}, {}, {}, {}]);
    });
  });
});
