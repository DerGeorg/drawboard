import { Page, WebSocketRoute } from '@playwright/test';

/**
 * A stand-in for the backend's collaboration socket (`drawboard.v1`, api/docs/collab-protocol.md)
 * inside the browser: `page.routeWebSocket` answers the board's WebSocket without a server.
 * WELCOME, an optional SNAPSHOT, SYNCED - then the test plays the other participants by sending
 * AWARENESS and PEER_LEFT frames the way the server wraps them (`From` + payload, S2.6).
 * Frames are written by hand here (not with the app's codec), so the app is tested against the
 * written protocol.
 */
export interface PeerFrom {
  id: string;
  name: string;
  guest: boolean;
  color: string;
  /** The board role the server names for a signed-in sender; a summon needs OWNER or EDITOR. */
  role?: string;
  clientId: number;
}

export class MockCollabSocket {
  private socket: WebSocketRoute | undefined;
  /** Awareness states the app sent (decoded JSON), oldest first. */
  readonly sentStates: Record<string, unknown>[] = [];
  private readonly clocks = new Map<number, number>();

  constructor(
    private readonly options: {
      role?: string;
      snapshot?: Uint8Array;
      self?: Omit<PeerFrom, 'clientId'>;
    } = {},
  ) {}

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/collab$/, (ws) => {
      this.socket = ws;
      ws.onMessage((message) => {
        if (typeof message === 'string') {
          return;
        }
        const bytes = new Uint8Array(message);
        if (bytes[0] === 0x02) {
          this.sentStates.push(decodeAwarenessState(bytes.subarray(1)));
        }
      });
      const self = this.options.self ?? {
        id: 'guest-1',
        name: 'Gina',
        guest: true,
        color: '#e8590c',
      };
      const welcome = JSON.stringify({
        role: this.options.role ?? 'EDITOR',
        self,
        limits: { update: 1_048_576, awareness: 16_384 },
      });
      ws.send(frame(0x80, varString(welcome)));
      if (this.options.snapshot) {
        ws.send(frame(0x81, varUint(1), this.options.snapshot));
      }
      ws.send(frame(0x83, varUint(this.options.snapshot ? 1 : 0)));
    });
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  /** The server relays a participant's awareness state (one entry, their own client id). */
  awareness(from: PeerFrom, state: Record<string, unknown> | null): void {
    const clock = (this.clocks.get(from.clientId) ?? 0) + 1;
    this.clocks.set(from.clientId, clock);
    const entry = concat(
      varUint(1),
      varUint(from.clientId),
      varUint(clock),
      varString(JSON.stringify(state)),
    );
    this.requireSocket().send(frame(0x85, varString(JSON.stringify(from)), entry));
  }

  /** The participant's session ended. */
  peerLeft(from: PeerFrom): void {
    this.requireSocket().send(frame(0x87, varString(JSON.stringify(from))));
  }

  /** The latest state the app sent, or undefined. */
  lastState(): Record<string, unknown> | undefined {
    return this.sentStates.at(-1);
  }

  private requireSocket(): WebSocketRoute {
    if (!this.socket) {
      throw new Error('the board has not connected yet');
    }
    return this.socket;
  }
}

function frame(type: number, ...parts: Uint8Array[]): Buffer {
  return Buffer.from(concat(Uint8Array.of(type), ...parts));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function varUint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function varString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concat(varUint(bytes.length), bytes);
}

function readVarUint(bytes: Uint8Array, at: { i: number }): number {
  let n = 0;
  let mult = 1;
  for (;;) {
    const b = bytes[at.i++] ?? 0;
    n += (b & 0x7f) * mult;
    if (b < 0x80) {
      return n;
    }
    mult *= 128;
  }
}

function decodeAwarenessState(bytes: Uint8Array): Record<string, unknown> {
  const at = { i: 0 };
  readVarUint(bytes, at); // count
  readVarUint(bytes, at); // client id
  readVarUint(bytes, at); // clock
  const len = readVarUint(bytes, at);
  const text = new TextDecoder().decode(bytes.subarray(at.i, at.i + len));
  return (JSON.parse(text) ?? {}) as Record<string, unknown>;
}
