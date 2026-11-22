import { PointerInfo } from '../input/events';
import {
  adoptInto,
  assignParents,
  isFrame,
  MIN_BLOCK_SIZE,
  Point,
  Props,
  normalizeRect,
} from '@apps/drawboard-engine';
import { Tool, ToolContext, ToolId } from './tool';

export interface CreateToolOptions {
  id: ToolId;
  /** Block type to create. */
  blockType: string;
  /** Props merged over the type's defaults (e.g. the shape kind). */
  props?: Props | (() => Props);
  /** Start text editing right after creating (and drop the block again if it stays empty). */
  editAfterCreate?: boolean;
  /** With editAfterCreate: keep the block even when no text was typed (a sticky is visible without text). */
  keepWhenEmpty?: boolean;
  /** Creates the block with an (empty) Y.Text. */
  withText?: boolean;
  /** The initial text (e.g. a frame's title); implies a Y.Text. */
  text?: () => string;
}

/**
 * Click places a block of the type's default size centered on the pointer; dragging draws it
 * to the dragged size. Afterwards the select tool is active with the new block selected.
 * Sticky, text and shapes are all this tool with different options.
 */
export class CreateTool implements Tool {
  readonly id: ToolId;
  readonly cursor = 'crosshair';
  private start: Point | undefined;
  private blockId: string | undefined;

  constructor(
    private readonly ctx: ToolContext,
    private readonly options: CreateToolOptions,
  ) {
    this.id = options.id;
  }

  pointerDown(e: PointerInfo): void {
    if (this.ctx.readOnly) {
      return;
    }
    this.ctx.stopCapturing();
    this.start = e.world;
    this.blockId = undefined;
  }

  pointerMove(e: PointerInfo): void {
    if (
      !this.start ||
      Math.hypot(e.world.x - this.start.x, e.world.y - this.start.y) < this.ctx.px(4)
    ) {
      return;
    }
    const r = normalizeRect(this.start, e.world);
    const rect = { ...r, w: Math.max(MIN_BLOCK_SIZE, r.w), h: Math.max(MIN_BLOCK_SIZE, r.h) };
    if (this.blockId) {
      this.ctx.board.setGeometry(this.blockId, rect);
    } else {
      this.blockId = this.create(rect);
    }
  }

  pointerUp(e: PointerInfo): void {
    if (!this.start) {
      return;
    }
    let id = this.blockId;
    if (!id) {
      const type = this.ctx.registry.get(this.options.blockType);
      const size = type?.defaultSize ?? { w: 160, h: 100 };
      id = this.create({ x: e.world.x - size.w / 2, y: e.world.y - size.h / 2, ...size });
    }
    this.start = undefined;
    this.blockId = undefined;
    if (id) {
      // same undo step: the new block joins the frame under it; a new frame takes in what it covers
      assignParents(this.ctx.board, [id]);
      if (isFrame(this.ctx.board.getBlock(id))) {
        adoptInto(this.ctx.board, id);
      }
    }
    this.ctx.stopCapturing();
    if (id) {
      this.ctx.selection.set([id]);
      this.ctx.setTool('select');
      if (this.options.editAfterCreate) {
        this.ctx.startTextEdit(id, { deleteIfEmpty: !this.options.keepWhenEmpty });
      }
    }
  }

  pointerCancel(): void {
    this.start = undefined;
    this.blockId = undefined;
  }

  private create(rect: { x: number; y: number; w: number; h: number }): string | undefined {
    const type = this.ctx.registry.get(this.options.blockType);
    if (!type) {
      return undefined;
    }
    return this.ctx.board.addBlock({
      type: type.type,
      ...rect,
      props: { ...type.defaultProps, ...resolveProps(this.options.props) },
      text:
        this.options.text?.() ?? ((this.options.withText ?? type.textEditable) ? '' : undefined),
    });
  }
}

function resolveProps(props: Props | (() => Props) | undefined): Props {
  return typeof props === 'function' ? props() : (props ?? {});
}
