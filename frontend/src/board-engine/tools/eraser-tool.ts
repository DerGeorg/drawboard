import { PointerInfo } from '../input/events';
import { Tool, ToolContext, ToolId } from './tool';

/** Deletes the freehand strokes the pointer passes over; one drag is one undo step. */
export class EraserTool implements Tool {
  readonly id: ToolId = 'eraser';
  readonly cursor = 'crosshair';
  private erasing = false;

  constructor(private readonly ctx: ToolContext) {}

  pointerDown(e: PointerInfo): void {
    if (this.ctx.readOnly) {
      return;
    }
    this.ctx.stopCapturing();
    this.erasing = true;
    this.erase(e);
  }

  pointerMove(e: PointerInfo): void {
    if (this.erasing) {
      this.erase(e);
    }
  }

  pointerUp(): void {
    this.erasing = false;
    this.ctx.stopCapturing();
  }

  pointerCancel(): void {
    this.erasing = false;
  }

  private erase(e: PointerInfo): void {
    const hit = this.ctx.hitTest(e.world);
    if (hit?.kind === 'stroke') {
      this.ctx.board.deleteItems([hit.id]);
    }
  }
}
