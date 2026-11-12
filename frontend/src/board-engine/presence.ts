import type { SummonState, ViewportState } from './collab/awareness-state';
import type { CollabRole } from './collab/frames';
import { Point } from './model/types';

/** A remote participant as the engine draws them. Name and color come from the server's `From`. */
export interface PeerPresence {
  clientId: number;
  /** `From.id` of the server (the authenticated principal): keys per-person decisions. */
  userId: string;
  name: string;
  color: string;
  /** The server marks guests (`From.guest`); the UI shows a badge for them. */
  guest: boolean;
  /** The board role the server names in `From.role`; null when it named none (allows nothing). */
  role: CollabRole | null;
  cursor: Point | null;
  /** Ids of the blocks, strokes and connectors the peer has selected. */
  selection: string[];
  /** What the peer looks at (centre and zoom); null until they published one. */
  viewport: ViewportState | null;
  /** The client id of the participant this peer follows, if any. */
  following: number | null;
  /** Who the peer asks to follow them ("bring everyone to me"); null when not presenting. */
  summon: SummonState | null;
}

/** What this client tells the others. */
export interface LocalPresence {
  cursor: Point | null;
  selection: string[];
}

const COLOR = /^#[0-9a-f]{3,8}$/i;

/** Only plain hex colors reach a style attribute. */
export function safeColor(color: unknown, fallback = '#e8590c'): string {
  return typeof color === 'string' && COLOR.test(color) ? color : fallback;
}
