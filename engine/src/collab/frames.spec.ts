import * as encoding from 'lib0/encoding';

import {
  ProtocolError,
  decodeAwarenessEntry,
  decodeServerFrame,
  encodeAwareness,
  encodePing,
  encodeUpdate,
} from './frames.js';

function frame(type: number, body: (e: encoding.Encoder) => void = () => undefined): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8(e, type);
  body(e);
  return encoding.toUint8Array(e);
}

const FROM = {
  id: 'u1',
  name: 'Alice',
  guest: false,
  color: '#e8590c',
  clientId: 42,
  extra: 'ignored',
};

describe('frames', () => {
  describe('client frames', () => {
    it('when encoding then the first byte is the type and the rest the payload', () => {
      expect(Array.from(encodeUpdate(Uint8Array.of(7, 8))), 'update').toEqual([0x01, 7, 8]);
      expect(Array.from(encodeAwareness(Uint8Array.of(9))), 'awareness').toEqual([0x02, 9]);
      expect(Array.from(encodePing()), 'ping').toEqual([0x03]);
    });
  });

  describe('decodeServerFrame', () => {
    it('when WELCOME arrives then role, self and limits are read and unknown fields ignored', () => {
      const m = decodeServerFrame(
        frame(0x80, (e) =>
          encoding.writeVarString(
            e,
            JSON.stringify({
              role: 'EDITOR',
              self: FROM,
              limits: { update: 5, awareness: 6 },
              future: 1,
            }),
          ),
        ),
      );

      expect(m, 'message').toEqual({
        type: 'welcome',
        role: 'EDITOR',
        self: { id: 'u1', name: 'Alice', guest: false, color: '#e8590c', clientId: 42 },
        limits: { update: 5, awareness: 6 },
      });
    });

    it('when WELCOME has no limits then the defaults apply, and a missing name becomes Unknown', () => {
      const m = decodeServerFrame(
        frame(0x80, (e) =>
          encoding.writeVarString(
            e,
            JSON.stringify({ role: 'VIEWER', self: { id: 'x', clientId: 1.5 } }),
          ),
        ),
      );

      expect(m, 'message').toMatchObject({
        role: 'VIEWER',
        limits: { update: 1_048_576, awareness: 16_384 },
        self: { name: 'Unknown', guest: false, color: '' },
      });
      expect(
        m.type === 'welcome' && m.self.clientId,
        'non-integer client id dropped',
      ).toBeUndefined();
    });

    it('when SNAPSHOT, UPDATE, SYNCED, ACK and COMPACT arrive then the numbers and bytes are read', () => {
      const tail = Uint8Array.of(1, 2, 3);
      const withTail = (type: number, n: number): Uint8Array =>
        frame(type, (e) => {
          encoding.writeVarUint(e, n);
          encoding.writeUint8Array(e, tail);
        });

      expect(decodeServerFrame(withTail(0x81, 300)), 'snapshot').toEqual({
        type: 'snapshot',
        upToSeq: 300,
        bytes: tail,
      });
      expect(decodeServerFrame(withTail(0x82, 5)), 'update').toEqual({
        type: 'update',
        seq: 5,
        bytes: tail,
      });
      expect(decodeServerFrame(frame(0x83, (e) => encoding.writeVarUint(e, 0))), 'synced').toEqual({
        type: 'synced',
        headSeq: 0,
      });
      expect(
        decodeServerFrame(frame(0x84, (e) => encoding.writeVarUint(e, 2 ** 40))),
        'ack with a large number',
      ).toEqual({ type: 'ack', seq: 2 ** 40 });
      expect(
        decodeServerFrame(frame(0x88, (e) => encoding.writeVarUint(e, 500))),
        'compact',
      ).toEqual({ type: 'compact', upToSeq: 500 });
      expect(decodeServerFrame(frame(0x89)), 'pong').toEqual({ type: 'pong' });
    });

    it('when From carries a valid role then it is kept, an unknown or non-string role is dropped', () => {
      const peerJoined = (from: unknown): unknown =>
        decodeServerFrame(frame(0x86, (e) => encoding.writeVarString(e, JSON.stringify(from))));
      const base = { id: 'u1', name: 'Alice', guest: false, color: '#e8590c' };

      expect(peerJoined({ ...base, role: 'EDITOR' }), 'editor').toEqual({
        type: 'peerJoined',
        from: { ...base, role: 'EDITOR' },
      });
      expect(peerJoined({ ...base, role: 'ADMIN' }), 'unknown role').toEqual({
        type: 'peerJoined',
        from: base,
      });
      expect(peerJoined({ ...base, role: 3 }), 'number').toEqual({
        type: 'peerJoined',
        from: base,
      });
      expect(peerJoined(base), 'absent').toEqual({ type: 'peerJoined', from: base });
    });

    it('when AWARENESS, PEER_JOINED, PEER_LEFT and ROLE arrive then From and payload are read', () => {
      const from = (type: number): Uint8Array =>
        frame(type, (e) => encoding.writeVarString(e, JSON.stringify(FROM)));
      const expected = { id: 'u1', name: 'Alice', guest: false, color: '#e8590c', clientId: 42 };

      expect(decodeServerFrame(from(0x86)), 'joined').toEqual({
        type: 'peerJoined',
        from: expected,
      });
      expect(decodeServerFrame(from(0x87)), 'left').toEqual({ type: 'peerLeft', from: expected });
      expect(
        decodeServerFrame(
          frame(0x85, (e) => {
            encoding.writeVarString(e, JSON.stringify(FROM));
            encoding.writeUint8Array(e, Uint8Array.of(4, 5));
          }),
        ),
        'awareness',
      ).toEqual({ type: 'awareness', from: expected, bytes: Uint8Array.of(4, 5) });
      expect(
        decodeServerFrame(
          frame(0x8a, (e) => encoding.writeVarString(e, JSON.stringify({ role: 'COMMENTER' }))),
        ),
        'role',
      ).toEqual({ type: 'role', role: 'COMMENTER' });
    });

    it.each([
      ['an empty frame', new Uint8Array()],
      ['an unknown type', Uint8Array.of(0x42)],
      ['a client type', Uint8Array.of(0x01)],
      ['a truncated varuint', Uint8Array.of(0x83)],
      ['invalid JSON', frame(0x80, (e) => encoding.writeVarString(e, '{nope'))],
      ['a JSON array', frame(0x80, (e) => encoding.writeVarString(e, '[]'))],
      [
        'an unknown role',
        frame(0x80, (e) => encoding.writeVarString(e, JSON.stringify({ role: 'GOD', self: {} }))),
      ],
      [
        'a missing From',
        frame(0x80, (e) => encoding.writeVarString(e, JSON.stringify({ role: 'EDITOR' }))),
      ],
    ])('when %s arrives then it is a protocol error', (_name, bytes) => {
      expect(() => decodeServerFrame(bytes), 'decoding').toThrow(ProtocolError);
    });
  });

  describe('decodeAwarenessEntry', () => {
    it('when the payload has one entry then client id, clock and state are read', () => {
      const bytes = (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 77);
        encoding.writeVarUint(e, 3);
        encoding.writeVarString(e, JSON.stringify({ cursor: null }));
        return encoding.toUint8Array(e);
      })();

      expect(decodeAwarenessEntry(bytes), 'entry').toEqual({
        clientId: 77,
        clock: 3,
        state: { cursor: null },
      });
    });

    it('when the payload has several entries or is broken then it is a protocol error', () => {
      const two = (() => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 2);
        return encoding.toUint8Array(e);
      })();

      expect(() => decodeAwarenessEntry(two), 'two entries').toThrow(ProtocolError);
      expect(() => decodeAwarenessEntry(Uint8Array.of(1, 1)), 'truncated').toThrow(ProtocolError);
    });
  });
});
