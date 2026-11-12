import { PointerInfo } from '../input/events';
import { Anchor, ConnectorEnd, Point, Rect } from '../model/types';
import { anchorPoint } from '../model/board-doc';
import { Tool, ToolContext, ToolId } from './tool';

/** The side of `rect` that `p` is closest to (for a point inside or near the block). */
export function nearestSide(rect: Rect, p: Point): Exclude<Anchor, 'auto'> {
  const d: [Exclude<Anchor, 'auto'>, number][] = [
    ['left', Math.abs(p.x - rect.x)],
    ['right', Math.abs(p.x - (rect.x + rect.w))],
    ['top', Math.abs(p.y - rect.y)],
    ['bottom', Math.abs(p.y - (rect.y + rect.h))],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0]?.[0] ?? 'right';
}

interface Drag {
  from: ConnectorEnd;
  fromPoint: Point;
  start: Point;
}

/**
 * Drag from a block (or empty space) to a block (or empty space). An end over a block snaps to
 * the nearest side; the other kind of end stays a free point. The connector then follows moved
 * blocks because it stores block ids, not coordinates.
 */
export class ConnectorTool implements Tool {
  readonly id: ToolId = 'connector';
  readonly cursor = 'crosshair';
  private drag: Drag | undefined;

  constructor(private readonly ctx: ToolContext) {}

  deactivate(): void {
    this.reset();
  }

  pointerDown(e: PointerInfo): void {
    if (this.ctx.readOnly) {
      return;
    }
    this.ctx.stopCapturing();
    const end = this.endAt(e.world);
    this.drag = { from: end.end, fromPoint: end.point, start: e.world };
  }

  pointerMove(e: PointerInfo): void {
    const d = this.drag;
    if (!d) {
      return;
    }
    const end = this.endAt(e.world);
    this.ctx.setHints({
      ghostLine: { from: d.fromPoint, to: end.point },
      ...(end.block ? { snapBlock: end.block } : {}),
    });
  }

  pointerUp(e: PointerInfo): void {
    const d = this.drag;
    this.reset();
    if (!d || Math.hypot(e.world.x - d.start.x, e.world.y - d.start.y) < this.ctx.px(6)) {
      return;
    }
    const to = this.endAt(e.world);
    const sameBlock = 'block' in d.from && 'block' in to.end && d.from.block === to.end.block;
    if (sameBlock) {
      return;
    }
    const id = this.ctx.board.addConnector(d.from, to.end, {
      color: this.ctx.drawStyle.color,
    });
    this.ctx.stopCapturing();
    this.ctx.selection.set([id]);
    this.ctx.setTool('select');
  }

  pointerCancel(): void {
    this.reset();
  }

  private reset(): void {
    this.drag = undefined;
    this.ctx.setHints({});
  }

  private endAt(world: Point): { end: ConnectorEnd; point: Point; block?: string } {
    const id = this.ctx.blockAt(world);
    const block = id ? this.ctx.board.getBlock(id) : undefined;
    if (id && block) {
      const anchor = nearestSide(block, world);
      return { end: { block: id, anchor }, point: anchorPoint(block, anchor, world), block: id };
    }
    return { end: { x: world.x, y: world.y }, point: world };
  }
}
