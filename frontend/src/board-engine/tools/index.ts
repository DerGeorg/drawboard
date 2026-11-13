import { FRAME_TYPE } from '../blocks/frame';
import { SHAPE_TYPE, ShapeKind } from '../blocks/shape';
import { STICKY_TYPE } from '../blocks/sticky';
import { TEXT_TYPE } from '../blocks/text';
import { ConnectorTool } from './connector-tool';
import { CreateTool } from './create-tool';
import { EmojiTool } from './emoji-tool';
import { EraserTool } from './eraser-tool';
import { HandTool } from './hand-tool';
import { PenTool } from './pen-tool';
import { SelectTool } from './select-tool';
import { TableTool } from './table-tool';
import { Tool, ToolContext, ToolId } from './tool';

/** One-letter shortcuts (V H S T R O D F G C P E). */
export const TOOL_SHORTCUTS: Readonly<Record<string, ToolId>> = {
  v: 'select',
  h: 'hand',
  s: 'sticky',
  t: 'text',
  r: 'rect',
  o: 'ellipse',
  d: 'diamond',
  f: 'frame',
  g: 'table',
  c: 'connector',
  p: 'pen',
  e: 'eraser',
};

/** Tools a read-only board may use. */
export const READ_ONLY_TOOLS: readonly ToolId[] = ['select', 'hand'];

const SHAPE_TOOLS: [ToolId, ShapeKind][] = [
  ['rect', 'rect'],
  ['ellipse', 'ellipse'],
  ['diamond', 'diamond'],
];

export function createTools(ctx: ToolContext): Map<ToolId, Tool> {
  const tools: Tool[] = [
    new SelectTool(ctx),
    new HandTool(ctx),
    new CreateTool(ctx, {
      id: 'sticky',
      blockType: STICKY_TYPE,
      props: () => ({ color: ctx.drawStyle.sticky }),
      editAfterCreate: true,
      // an empty sticky is still a visible card on the board (Georg, 2026-11-10): it stays
      keepWhenEmpty: true,
    }),
    new CreateTool(ctx, { id: 'text', blockType: TEXT_TYPE, editAfterCreate: true }),
    ...SHAPE_TOOLS.map(
      ([id, kind]) =>
        new CreateTool(ctx, {
          id,
          blockType: SHAPE_TYPE,
          props: () => ({ kind, fill: ctx.drawStyle.fill, stroke: ctx.drawStyle.color }),
        }),
    ),
    new CreateTool(ctx, {
      id: 'frame',
      blockType: FRAME_TYPE,
      props: () => ({ fill: '#ffffff' }),
      // "Frame 3": numbered like Miro does
      text: () => `Frame ${ctx.board.blocks().filter((b) => b.type === FRAME_TYPE).length + 1}`,
    }),
    new TableTool(ctx),
    new ConnectorTool(ctx),
    new PenTool(ctx),
    new EraserTool(ctx),
    new EmojiTool(ctx),
  ];
  return new Map(tools.map((t) => [t.id, t]));
}
