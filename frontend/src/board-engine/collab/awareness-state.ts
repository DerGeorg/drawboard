import { MAX_ZOOM, MIN_ZOOM } from '../camera';
import { Point } from '../model/types';

/**
 * The awareness state every client publishes (y-protocols awareness, relayed by the server as
 * `{from, payload}`, S2.6). Minimal data, no free text: names and colours come only from the
 * server's `From`, never from here.
 *
 * ```
 * cursor     {x, y} | null              world point under the pointer
 * selection  string[] (<= 100)          ids of the selected items
 * viewport   {x, y, zoom}               centre of the visible area (world, rounded) and zoom
 * following  uint32                     Yjs client id of the participant this client follows
 * summon     {id: uint31, targets: "all" | uint32[] (1..50)}
 *                                       "follow me": who is asked to follow this client
 * ```
 *
 * The state of a peer is input from any participant of the board (the server relays awareness
 * for viewers and guests too, S2.4), so `parsePeerState` validates every field on its own: a
 * field that does not match is treated as absent, unknown fields are ignored.
 */
export interface ViewportState {
  /** Centre of the visible area in world units (integers). */
  x: number;
  y: number;
  zoom: number;
}

/** "Bring everyone to me": the participants asked to follow. */
export interface SummonState {
  /** New for every summon (random): a receiver decides once per (sender, id). */
  id: number;
  /** Everyone on the board, or these Yjs client ids. */
  targets: 'all' | number[];
}

export interface PeerState {
  cursor: Point | null;
  selection: string[];
  viewport: ViewportState | null;
  following: number | null;
  summon: SummonState | null;
}

/** Bound of world coordinates in the awareness (far beyond any real board). */
export const MAX_COORD = 10_000_000;
export const MAX_SELECTION_IDS = 100;
export const MAX_SUMMON_TARGETS = 50;
const MAX_ID_LENGTH = 64;
const MAX_CLIENT_ID = 0xffff_ffff;
const MAX_SUMMON_ID = 0x7fff_ffff;

/** The viewport as published: centre rounded to whole world units, zoom to 4 decimals. */
export function encodeViewport(center: Point, zoom: number): ViewportState {
  return {
    x: clampCoord(Math.round(center.x)),
    y: clampCoord(Math.round(center.y)),
    zoom: Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 10_000) / 10_000,
  };
}

export function sameViewport(a: ViewportState | null, b: ViewportState | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.zoom === b.zoom);
}

/** A new summon id: random, so a reload of the presenter never repeats an id already seen. */
export function newSummonId(random: () => number = Math.random): number {
  return 1 + Math.floor(random() * (MAX_SUMMON_ID - 1));
}

/** True if `summon` asks the client with `clientId` to follow. */
export function summons(summon: SummonState | null, clientId: number): boolean {
  return summon !== null && (summon.targets === 'all' || summon.targets.includes(clientId));
}

/** Every field of a peer's state validated on its own; anything else is ignored. */
export function parsePeerState(state: unknown): PeerState {
  const s = isRecord(state) ? state : {};
  return {
    cursor: parseCursor(field(s, 'cursor')),
    selection: parseSelection(field(s, 'selection')),
    viewport: parseViewport(field(s, 'viewport')),
    following: parseClientId(field(s, 'following')),
    summon: parseSummon(field(s, 'summon')),
  };
}

export function parseCursor(v: unknown): Point | null {
  if (!isRecord(v)) {
    return null;
  }
  const x = field(v, 'x');
  const y = field(v, 'y');
  return isCoord(x) && isCoord(y) ? { x, y } : null;
}

export function parseSelection(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .slice(0, MAX_SELECTION_IDS)
        .filter((id): id is string => typeof id === 'string' && id.length <= MAX_ID_LENGTH)
    : [];
}

export function parseViewport(v: unknown): ViewportState | null {
  if (!isRecord(v)) {
    return null;
  }
  const x = field(v, 'x');
  const y = field(v, 'y');
  const zoom = field(v, 'zoom');
  return isCoord(x) &&
    isCoord(y) &&
    typeof zoom === 'number' &&
    Number.isFinite(zoom) &&
    zoom >= MIN_ZOOM &&
    zoom <= MAX_ZOOM
    ? { x, y, zoom }
    : null;
}

export function parseClientId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_CLIENT_ID ? v : null;
}

/** A summon with more than MAX_SUMMON_TARGETS targets, or any bad target, is no summon at all. */
export function parseSummon(v: unknown): SummonState | null {
  if (!isRecord(v)) {
    return null;
  }
  const id = field(v, 'id');
  const targets = field(v, 'targets');
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > MAX_SUMMON_ID) {
    return null;
  }
  if (targets === 'all') {
    return { id, targets };
  }
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_SUMMON_TARGETS) {
    return null;
  }
  const ids = targets.map(parseClientId);
  return ids.every((t): t is number => t !== null) ? { id, targets: ids } : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own properties only: `__proto__`, `constructor` and friends never come from the prototype. */
function field(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function isCoord(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
}

function clampCoord(v: number): number {
  return Math.min(MAX_COORD, Math.max(-MAX_COORD, v));
}
