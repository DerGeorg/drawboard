import { PointerInfo } from '../input/events';
import { adoptInto, assignParents, createTable } from '@apps/drawboard-engine';
import { Tool, ToolContext, ToolId } from './tool';

/**
 * A click places a table (3 x 3 with a header row, model/tables.ts) centred on the pointer, as
 * one undo step; it joins the frame under it and takes in what it covers. Afterwards the select
 * tool is active with the table selected.
 */
export class TableTool implements Tool {
  readonly id: ToolId = 'table';
  readonly cursor = 'crosshair';
  private pressed = false;

  constructor(private readonly ctx: ToolContext) {}

  pointerDown(): void {
    this.pressed = !this.ctx.readOnly;
  }

  pointerMove(): void {
    // a table has a fixed starting size: dragging changes nothing
  }

  pointerUp(e: PointerInfo): void {
    if (!this.pressed) {
      return;
    }
    this.pressed = false;
    const { board } = this.ctx;
    this.ctx.stopCapturing();
    let id = '';
    board.transact(() => {
      id = createTable(board, e.world);
      assignParents(board, [id]);
      adoptInto(board, id);
    });
    this.ctx.stopCapturing();
    this.ctx.selection.set([id]);
    this.ctx.setTool('select');
  }

  pointerCancel(): void {
    this.pressed = false;
  }
}
