import {
  EMOJI_DEFAULT_SIZE,
  EMOJI_TYPE,
  assignParents,
  Point,
  isValidEmoji,
} from '@apps/drawboard-engine';
import { KeyInfo, PointerInfo } from '../input/events';
import { Tool, ToolContext, ToolId } from './tool';

/**
 * The stamp: every click puts the chosen emoji (`drawStyle.emoji`) centred on the pointer. The
 * tool stays active until Escape or another tool, so reactions and dot votes go quickly.
 */
export class EmojiTool implements Tool {
  readonly id: ToolId = 'emoji';
  readonly cursor = 'copy';
  private start: Point | undefined;

  constructor(private readonly ctx: ToolContext) {}

  pointerDown(e: PointerInfo): void {
    if (this.ctx.readOnly) {
      return;
    }
    this.start = e.world;
  }

  pointerMove(): void {
    // a stamp is a click: nothing to follow
  }

  pointerUp(e: PointerInfo): void {
    const start = this.start;
    this.start = undefined;
    if (!start || Math.hypot(e.world.x - start.x, e.world.y - start.y) > this.ctx.px(4)) {
      return;
    }
    const emoji = this.ctx.drawStyle.emoji;
    const type = this.ctx.registry.get(EMOJI_TYPE);
    if (!type || !isValidEmoji(emoji)) {
      return;
    }
    const size = type.defaultSize ?? { w: EMOJI_DEFAULT_SIZE, h: EMOJI_DEFAULT_SIZE };
    this.ctx.stopCapturing();
    const id = this.ctx.board.addBlock({
      type: EMOJI_TYPE,
      x: e.world.x - size.w / 2,
      y: e.world.y - size.h / 2,
      ...size,
      props: { ...type.defaultProps, emoji },
    });
    // same undo step: a stamp dropped on a frame joins it
    assignParents(this.ctx.board, [id]);
    this.ctx.stopCapturing();
  }

  pointerCancel(): void {
    this.start = undefined;
  }

  keyDown(e: KeyInfo): boolean {
    if (e.key === 'Escape') {
      this.ctx.setTool('select');
      return true;
    }
    return false;
  }
}
