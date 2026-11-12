import { panBy } from '../camera';
import { PointerInfo } from '../input/events';
import { Point } from '../model/types';
import { Tool, ToolContext, ToolId } from './tool';

/** Pans the camera by dragging. The engine also routes space+drag and middle button here. */
export class HandTool implements Tool {
  readonly id: ToolId = 'hand';
  readonly cursor = 'grab';
  private last: Point | undefined;

  constructor(private readonly ctx: ToolContext) {}

  pointerDown(e: PointerInfo): void {
    this.last = e.screen;
  }

  pointerMove(e: PointerInfo): void {
    if (!this.last) {
      return;
    }
    this.ctx.setCamera(panBy(this.ctx.camera, e.screen.x - this.last.x, e.screen.y - this.last.y));
    this.last = e.screen;
  }

  pointerUp(): void {
    this.last = undefined;
  }

  pointerCancel(): void {
    this.last = undefined;
  }
}
