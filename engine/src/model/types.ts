/** Plain data types of the board model. The Y.Doc holds them as Y.Maps; these are the typed reads. */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect extends Point, Size {}

export type Anchor = 'auto' | 'top' | 'right' | 'bottom' | 'left';

/** One end of a connector: attached to a block side, or a free point in world coordinates. */
export type ConnectorEnd = { block: string; anchor: Anchor } | Point;

export function isBlockEnd(end: ConnectorEnd): end is { block: string; anchor: Anchor } {
  return 'block' in end;
}

export type Props = Record<string, unknown>;

export interface BlockData {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Stacking order; a new block gets max + 1. */
  z: number;
  /** Id of a containing frame (later milestones), or null. */
  parent: string | null;
  locked: boolean;
  props: Props;
  /** True if the block has a Y.Text. */
  hasText: boolean;
}

export interface ConnectorStyle {
  color: string;
  width: number;
  arrow: boolean;
  dashed: boolean;
}

export interface ConnectorData {
  id: string;
  from: ConnectorEnd;
  to: ConnectorEnd;
  style: ConnectorStyle;
  label: string;
}

export interface StrokeStyle {
  color: string;
  size: number;
}

export interface StrokeData {
  id: string;
  /** Flat `[x, y, pressure, x, y, pressure, ...]` in world coordinates. */
  points: number[];
  style: StrokeStyle;
}

/** What changed in one transaction (ids only; read the new values from the BoardDoc). */
export interface BoardChange {
  blocks: ReadonlySet<string>;
  connectors: ReadonlySet<string>;
  strokes: ReadonlySet<string>;
  meta: boolean;
  /** True if the transaction came from this client's own edits (not remote, not undo). */
  local: boolean;
}

export const MIN_BLOCK_SIZE = 24;
export const MAX_TEXT_LENGTH = 100_000;
export const SCHEMA_VERSION = 1;
