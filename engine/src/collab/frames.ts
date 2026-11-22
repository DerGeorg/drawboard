import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** Wire format of subprotocol `drawboard.v1` (api/docs/collab-protocol.md). */
export const SUBPROTOCOL = 'drawboard.v1';

export enum ClientFrame {
  Update = 0x01,
  Awareness = 0x02,
  Ping = 0x03,
}

export enum ServerFrame {
  Welcome = 0x80,
  Snapshot = 0x81,
  Update = 0x82,
  Synced = 0x83,
  Ack = 0x84,
  Awareness = 0x85,
  PeerJoined = 0x86,
  PeerLeft = 0x87,
  Compact = 0x88,
  Pong = 0x89,
  Role = 0x8a,
}

export type CollabRole = 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER';

/** The identity of a participant, built by the server from the authenticated principal. */
export interface From {
  id: string;
  name: string;
  guest: boolean;
  color: string;
  /**
   * The sender's current board role, set by the server and changed with every role re-check;
   * absent from an older server or when unknown, and then it allows nothing.
   */
  role?: CollabRole;
  /** The Yjs clientID bound to the session; absent until its first awareness frame. */
  clientId?: number;
}

export interface Limits {
  update: number;
  awareness: number;
}

export type ServerMessage =
  | { type: 'welcome'; role: CollabRole; self: From; limits: Limits }
  | { type: 'snapshot'; upToSeq: number; bytes: Uint8Array }
  | { type: 'update'; seq: number; bytes: Uint8Array }
  | { type: 'synced'; headSeq: number }
  | { type: 'ack'; seq: number }
  | { type: 'awareness'; from: From; bytes: Uint8Array }
  | { type: 'peerJoined'; from: From }
  | { type: 'peerLeft'; from: From }
  | { type: 'compact'; upToSeq: number }
  | { type: 'pong' }
  | { type: 'role'; role: CollabRole };

/** A frame the protocol does not allow (the provider reacts like to close code 4400). */
export class ProtocolError extends Error {}

export const DEFAULT_LIMITS: Limits = { update: 1_048_576, awareness: 16_384 };

const ROLES: readonly string[] = ['OWNER', 'EDITOR', 'COMMENTER', 'VIEWER'];

export function encodeUpdate(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8(e, ClientFrame.Update);
  encoding.writeUint8Array(e, update);
  return encoding.toUint8Array(e);
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8(e, ClientFrame.Awareness);
  encoding.writeUint8Array(e, update);
  return encoding.toUint8Array(e);
}

export function encodePing(): Uint8Array {
  return Uint8Array.of(ClientFrame.Ping);
}

export function decodeServerFrame(data: Uint8Array): ServerMessage {
  const d = decoding.createDecoder(data);
  try {
    if (!decoding.hasContent(d)) {
      throw new ProtocolError('empty frame');
    }
    const type = decoding.readUint8(d);
    switch (type) {
      case ServerFrame.Welcome: {
        const json = parseJson(decoding.readVarString(d));
        const role = parseRole(json['role']);
        const limits = (json['limits'] ?? {}) as Partial<Limits>;
        return {
          type: 'welcome',
          role,
          self: parseFrom(json['self']),
          limits: {
            update: positive(limits.update, DEFAULT_LIMITS.update),
            awareness: positive(limits.awareness, DEFAULT_LIMITS.awareness),
          },
        };
      }
      case ServerFrame.Snapshot:
        return {
          type: 'snapshot',
          upToSeq: decoding.readVarUint(d),
          bytes: decoding.readTailAsUint8Array(d),
        };
      case ServerFrame.Update:
        return {
          type: 'update',
          seq: decoding.readVarUint(d),
          bytes: decoding.readTailAsUint8Array(d),
        };
      case ServerFrame.Synced:
        return { type: 'synced', headSeq: decoding.readVarUint(d) };
      case ServerFrame.Ack:
        return { type: 'ack', seq: decoding.readVarUint(d) };
      case ServerFrame.Awareness: {
        const from = parseFrom(parseJson(decoding.readVarString(d)));
        return { type: 'awareness', from, bytes: decoding.readTailAsUint8Array(d) };
      }
      case ServerFrame.PeerJoined:
        return { type: 'peerJoined', from: parseFrom(parseJson(decoding.readVarString(d))) };
      case ServerFrame.PeerLeft:
        return { type: 'peerLeft', from: parseFrom(parseJson(decoding.readVarString(d))) };
      case ServerFrame.Compact:
        return { type: 'compact', upToSeq: decoding.readVarUint(d) };
      case ServerFrame.Pong:
        return { type: 'pong' };
      case ServerFrame.Role:
        return { type: 'role', role: parseRole(parseJson(decoding.readVarString(d))['role']) };
      default:
        throw new ProtocolError(`unknown message type 0x${type.toString(16)}`);
    }
  } catch (e) {
    throw e instanceof ProtocolError ? e : new ProtocolError(`malformed frame: ${String(e)}`);
  }
}

/** The single entry of an awareness payload (`varuint count` = 1, then clientID, clock, state). */
export function decodeAwarenessEntry(bytes: Uint8Array): {
  clientId: number;
  clock: number;
  state: unknown;
} {
  const d = decoding.createDecoder(bytes);
  try {
    const count = decoding.readVarUint(d);
    if (count !== 1) {
      throw new ProtocolError(`awareness frame with ${count} entries`);
    }
    const clientId = decoding.readVarUint(d);
    const clock = decoding.readVarUint(d);
    const state: unknown = JSON.parse(decoding.readVarString(d));
    return { clientId, clock, state };
  } catch (e) {
    throw e instanceof ProtocolError
      ? e
      : new ProtocolError(`malformed awareness payload: ${String(e)}`);
  }
}

function parseJson(text: string): Record<string, unknown> {
  const v: unknown = JSON.parse(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ProtocolError('expected a JSON object');
  }
  return v as Record<string, unknown>;
}

function parseRole(v: unknown): CollabRole {
  if (typeof v !== 'string' || !ROLES.includes(v)) {
    throw new ProtocolError(`unknown role ${String(v)}`);
  }
  return v as CollabRole;
}

function parseFrom(v: unknown): From {
  if (typeof v !== 'object' || v === null) {
    throw new ProtocolError('missing From');
  }
  const o = v as Record<string, unknown>;
  const clientId = o['clientId'];
  const role = o['role'];
  return {
    id: typeof o['id'] === 'string' ? o['id'] : '',
    name: typeof o['name'] === 'string' ? o['name'] : 'Unknown',
    guest: o['guest'] === true,
    color: typeof o['color'] === 'string' ? o['color'] : '',
    ...(typeof role === 'string' && ROLES.includes(role) ? { role: role as CollabRole } : {}),
    ...(typeof clientId === 'number' && Number.isSafeInteger(clientId) ? { clientId } : {}),
  };
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && v > 0 ? v : fallback;
}
