import { Camera, BoardDoc, Point, Rect } from '@apps/drawboard-engine';
import { KeyInfo, PointerInfo } from '../input/events';
import { EstimateSource } from '../blocks/story';
import { BlockTypeRegistry } from '../renderer/block-registry';
import { SelectionState } from '../selection';

export type ToolId =
  | 'select'
  | 'hand'
  | 'sticky'
  | 'text'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'frame'
  | 'table'
  | 'connector'
  | 'pen'
  | 'eraser'
  | 'emoji';

export type HitResult =
  | { kind: 'block'; id: string }
  | { kind: 'connector'; id: string }
  | { kind: 'stroke'; id: string };

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** What the overlay layer shows besides the selection (marquee, hints). Screen space. */
export interface OverlayHints {
  marquee?: Rect;
  /** Block id a connector would snap to, shown as a highlight. */
  snapBlock?: string;
  /** A connector being dragged (world coordinates). */
  ghostLine?: { from: Point; to: Point };
  /** A stroke being drawn (world coordinates), shown before it is written to the document. */
  liveStroke?: { points: number[]; color: string; size: number };
}

/** The engine as a tool sees it. */
export interface ToolContext {
  readonly board: BoardDoc;
  readonly selection: SelectionState;
  readonly registry: BlockTypeRegistry;
  readonly camera: Camera;
  readonly readOnly: boolean;
  /** Pen/shape defaults for new items (set by the style panel). */
  readonly drawStyle: {
    color: string;
    size: number;
    fill: string;
    sticky: string;
    /** The emoji the stamp tool places. */
    emoji: string;
  };
  setCamera(camera: Camera): void;
  hitTest(world: Point): HitResult | undefined;
  /** The block under the point (ignores strokes and connectors). */
  blockAt(world: Point): string | undefined;
  /** The element a mounted block is rendered in (undefined while it is not mounted). */
  blockElement(id: string): HTMLElement | undefined;
  /** The viewport (client) position of a point in container pixels. */
  clientAt(screen: Point): Point;
  /** Open planning poker rounds per story card, when the host provides them. */
  readonly estimates: EstimateSource | undefined;
  /** Handle of the single selected block under the screen point. */
  handleAt(screen: Point): HandleId | undefined;
  setTool(id: ToolId): void;
  startTextEdit(blockId: string, options?: { deleteIfEmpty?: boolean }): void;
  /** Asks the host to open the block's own editor (types with `opensEditor`). */
  openBlock(blockId: string): void;
  setHints(hints: OverlayHints): void;
  /** Tells the user something non-blocking (the host shows it as a toast). */
  notify(message: string): void;
  /** Starts a new undo step; call before and after a gesture. */
  stopCapturing(): void;
  /** Distance in world units that equals `px` screen pixels at the current zoom. */
  px(px: number): number;
}

export interface Tool {
  readonly id: ToolId;
  readonly cursor: string;
  activate?(): void;
  deactivate?(): void;
  pointerDown(e: PointerInfo): void;
  pointerMove(e: PointerInfo): void;
  pointerUp(e: PointerInfo): void;
  pointerCancel?(): void;
  doubleClick?(e: PointerInfo): void;
  /** Returns true if the tool handled the key (the engine then prevents the default). */
  keyDown?(e: KeyInfo): boolean;
}
