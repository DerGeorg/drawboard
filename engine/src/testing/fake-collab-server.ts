import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

import { CollabRole, From } from '../collab/frames.js';
import { SocketLike } from '../collab/provider.js';

/**
 * An in-process drawboard.v1 server for tests: an update log with sequence numbers, a fake
 * WebSocket class and the server side of the protocol. It builds frames with lib0 on its own
 * (not through the client codec), so the codec is tested against the written protocol.
 */
export class FakeSession implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  /** Frames the client sent, decoded as `[type, payload]`. */
  readonly received: { type: number; payload: Uint8Array }[] = [];
  from: From;
  role: CollabRole;
  closedByClient: number | undefined;

  constructor(
    readonly server: FakeCollabServer,
    readonly url: string,
    readonly protocols: string[],
    id: string,
    role: CollabRole,
  ) {
    this.role = role;
    this.from = { id, name: `User ${id}`, guest: false, color: '#e8590c' };
  }

  send(data: Uint8Array): void {
    const type = data[0] ?? 0;
    const frame = { type, payload: data.slice(1) };
    this.received.push(frame);
    this.server.onClientFrame(this, frame);
  }

  close(code = 1000): void {
    if (this.readyState === 3) {
      return;
    }
    this.closedByClient = code;
    this.readyState = 3;
    this.server.sessions.delete(this);
    this.server.broadcast(this, 0x87, () => undefined, this.from);
  }

  framesOf(type: number): { type: number; payload: Uint8Array }[] {
    return this.received.filter((f) => f.type === type);
  }

  // ---- server -> client ----------------------------------------------------------------------

  deliver(bytes: Uint8Array): void {
    if (this.readyState === 1) {
      const copy = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      this.onmessage?.({ data: copy });
    }
  }

  /** Closes like the server would. */
  serverClose(code: number): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.server.sessions.delete(this);
    this.onclose?.({ code });
    this.server.broadcast(this, 0x87, () => undefined, this.from);
  }
}

export class FakeCollabServer {
  readonly log: { seq: number; bytes: Uint8Array }[] = [];
  snapshot: { upToSeq: number; bytes: Uint8Array } | undefined;
  readonly sessions = new Set<FakeSession>();
  /** Every socket ever created, in order. */
  readonly all: FakeSession[] = [];
  nextRole: CollabRole = 'EDITOR';
  /** Answer the next handshakes with a failed upgrade (close 1006 before open). */
  failHandshakes = 0;
  /** Close the next sockets with this code right after the upgrade, before any WELCOME. */
  closeAfterOpen: number[] = [];
  private nextId = 1;

  readonly createSocket = (url: string, protocols: string[]): SocketLike => {
    const s = new FakeSession(this, url, protocols, `u${this.nextId++}`, this.nextRole);
    this.all.push(s);
    queueMicrotask(() => this.accept(s));
    return s;
  };

  get head(): number {
    return this.log.at(-1)?.seq ?? this.snapshot?.upToSeq ?? 0;
  }

  private accept(s: FakeSession): void {
    if (this.failHandshakes > 0) {
      this.failHandshakes--;
      s.readyState = 3;
      s.onclose?.({ code: 1006 });
      return;
    }
    s.readyState = 1;
    s.onopen?.({});
    const closeCode = this.closeAfterOpen.shift();
    if (closeCode !== undefined) {
      s.serverClose(closeCode);
      return;
    }
    s.deliver(
      frame(0x80, (e) =>
        encoding.writeVarString(
          e,
          JSON.stringify({
            role: s.role,
            self: s.from,
            limits: { update: 1_048_576, awareness: 16_384 },
          }),
        ),
      ),
    );
    if (this.snapshot) {
      const snap = this.snapshot;
      s.deliver(
        frame(0x81, (e) => {
          encoding.writeVarUint(e, snap.upToSeq);
          encoding.writeUint8Array(e, snap.bytes);
        }),
      );
    }
    for (const entry of this.log.filter((x) => x.seq > (this.snapshot?.upToSeq ?? 0))) {
      s.deliver(updateFrame(entry.seq, entry.bytes));
    }
    s.deliver(frame(0x83, (e) => encoding.writeVarUint(e, this.head)));
    this.sessions.add(s);
    this.broadcast(s, 0x86, () => undefined, s.from);
  }

  onClientFrame(s: FakeSession, f: { type: number; payload: Uint8Array }): void {
    switch (f.type) {
      case 0x01: {
        if (s.role !== 'OWNER' && s.role !== 'EDITOR') {
          return; // dropped and counted
        }
        const seq = this.head + 1;
        this.log.push({ seq, bytes: f.payload });
        s.deliver(frame(0x84, (e) => encoding.writeVarUint(e, seq)));
        for (const other of this.sessions) {
          if (other !== s) {
            other.deliver(updateFrame(seq, f.payload));
          }
        }
        return;
      }
      case 0x02: {
        const d = decoding.createDecoder(f.payload);
        const count = decoding.readVarUint(d);
        const clientId = decoding.readVarUint(d);
        if (count !== 1) {
          return;
        }
        s.from = { ...s.from, clientId };
        this.broadcast(s, 0x85, (e) => encoding.writeUint8Array(e, f.payload), s.from);
        return;
      }
      case 0x03:
        s.deliver(Uint8Array.of(0x89));
        return;
    }
  }

  /** Sends a frame with a `From` header to every other session. */
  broadcast(
    origin: FakeSession,
    type: number,
    tail: (e: encoding.Encoder) => void,
    from: From,
  ): void {
    for (const other of this.sessions) {
      if (other !== origin) {
        other.deliver(
          frame(type, (e) => {
            encoding.writeVarString(e, JSON.stringify(from));
            tail(e);
          }),
        );
      }
    }
  }

  compact(s: FakeSession, upToSeq: number): void {
    s.deliver(frame(0x88, (e) => encoding.writeVarUint(e, upToSeq)));
  }

  setRole(s: FakeSession, role: CollabRole): void {
    s.role = role;
    s.deliver(frame(0x8a, (e) => encoding.writeVarString(e, JSON.stringify({ role }))));
  }

  /** A raw frame for protocol-error tests. */
  raw(s: FakeSession, bytes: Uint8Array): void {
    s.deliver(bytes);
  }

  /** Seeds the log with updates, as if other clients had written them. */
  seed(...updates: Uint8Array[]): void {
    for (const bytes of updates) {
      this.log.push({ seq: this.head + 1, bytes });
    }
  }
}

function frame(type: number, body: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8(e, type);
  body(e);
  return encoding.toUint8Array(e);
}

function updateFrame(seq: number, bytes: Uint8Array): Uint8Array {
  return frame(0x82, (e) => {
    encoding.writeVarUint(e, seq);
    encoding.writeUint8Array(e, bytes);
  });
}
