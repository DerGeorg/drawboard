import { PointerInfo } from '../input/events';
import { Tool, ToolContext, ToolId } from './tool';

/**
 * Freehand drawing with perfect-freehand. The raw points are stored (flat `[x, y, pressure]`);
 * the outline is computed when rendering. While drawing, the preview lives in the overlay and
 * the stroke is written to the document once, on release.
 */
export class PenTool implements Tool {
  readonly id: ToolId = 'pen';
  readonly cursor = 'crosshair';
  private points: number[] | undefined;

  constructor(private readonly ctx: ToolContext) {}

  deactivate(): void {
    this.cancel();
  }

  pointerDown(e: PointerInfo): void {
    if (this.ctx.readOnly) {
      return;
    }
    this.ctx.stopCapturing();
    this.points = [e.world.x, e.world.y, e.pressure];
    this.preview();
  }

  pointerMove(e: PointerInfo): void {
    const pts = this.points;
    if (!pts) {
      return;
    }
    const lx = pts[pts.length - 3] ?? 0;
    const ly = pts[pts.length - 2] ?? 0;
    if (Math.hypot(e.world.x - lx, e.world.y - ly) < this.ctx.px(1.5)) {
      return;
    }
    pts.push(e.world.x, e.world.y, e.pressure);
    this.preview();
  }

  pointerUp(): void {
    const pts = this.points;
    this.cancel();
    if (pts) {
      const { color, size } = this.ctx.drawStyle;
      this.ctx.board.addStroke(pts, { color, size });
      this.ctx.stopCapturing();
    }
  }

  pointerCancel(): void {
    this.cancel();
  }

  private preview(): void {
    if (this.points) {
      const { color, size } = this.ctx.drawStyle;
      this.ctx.setHints({ liveStroke: { points: [...this.points], color, size } });
    }
  }

  private cancel(): void {
    this.points = undefined;
    this.ctx.setHints({});
  }
}
