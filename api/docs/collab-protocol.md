# Collaboration protocol `drawboard.v1`

The real-time part of the contract: how a browser and the backend keep a
board's drawing in sync over a WebSocket. OpenAPI cannot describe it, so it
lives here, next to the REST contract it belongs to. Backend (module `collab`)
and frontend (collab provider) implement exactly this; a change that an old
peer cannot understand needs a new subprotocol (`drawboard.v2`), not a new
package version.

Security requirements quoted as S2.n come from the security review
(`docs/architecture.md` of the app, section "Security decisions").

## Model

The drawing is one [Yjs](https://yjs.dev) document per board. The server
**never reads it**: it stores and relays Yjs updates as opaque bytes.

* **Update log:** every accepted update gets the next **sequence number**
  (`seq`, per board, starting at 1, no gaps) and is appended to the log.
* **Snapshot:** one Yjs update that contains the whole document up to some
  `seq` (`upToSeq`). Uploaded by a client over REST when the server asks
  (compaction), never sent by a client over the WebSocket.
* **Join:** the server sends the latest snapshot and every log entry after it.
  Yjs updates are commutative and idempotent, so applying an update twice or
  out of order is harmless; the sequence numbers are for compaction and
  acknowledgements, not for correctness of the document.
* **Awareness** (cursor, selection, name of each participant) is relayed,
  never stored.

## Opening the socket

1. `POST /api/boards/{boardId}/collab-ticket` with the bearer token returns
   `CollabTicket {ticket, expiresAt, url, protocol}` (S2.1).
2. `new WebSocket(origin + url, ['drawboard.v1', 'ticket.' + ticket])` with
   `origin` = `wss://<host>` (`ws://` only on localhost). The ticket is never
   put into the URL.
3. The server (S2.2):
   * redeems the ticket (unknown, used or older than 30 s → HTTP 401),
   * requires the subprotocol `drawboard.v1` (missing or another → HTTP 400)
     and answers with exactly `drawboard.v1`,
   * requires `Origin` to equal the configured public URL exactly (else 403),
   * resolves the user's role on the board again (no role → 404),
   * then upgrades. A failed handshake looks like close code 1006 in the
     browser; the client then asks for a new ticket once and gives up after
     a second failure (it shows "connection failed" and retries with backoff).

The session ends at the latest when the access token behind the ticket
expires (close code 4401, S2.3). The client then fetches a new ticket with
its current token and reconnects at once.

## Frames

Every message is **one binary WebSocket frame**. Text frames are a protocol
error (4400). The first byte is the message type; the rest is the payload.

Encodings (the same as `lib0/encoding`, which Yjs clients already have):

* `varuint`: unsigned LEB128 — 7 bits per byte, least significant group
  first, high bit set on every byte but the last. At most 8 bytes (values
  below 2^53).
* `varstring`: `varuint` byte length, then that many bytes UTF-8.
* `bytes`: the rest of the frame, no length prefix.

`From` is a `varstring` with a JSON object the **server** builds from the
authenticated principal (S2.6). Clients render names only from it, never
from the awareness payload:

```json
{"id": "0192f5e0-…", "name": "Alice", "guest": false, "color": "#e8590c", "role": "EDITOR", "clientId": 123456789}
```

`id` is the user's id (`CurrentUser.id`), `name` the display name (else the
username), `color` derived from the id by the server, `role` the sender's
current board role (`OWNER`, `EDITOR`, `COMMENTER`, `VIEWER`; the same value
the session got in `WELCOME` or the last `ROLE`, so it changes with the
minutely re-check), `clientId` the Yjs `clientID` bound to the session (absent
until the session sent its first awareness frame). Clients must ignore unknown
fields; a client that acts on `role` (a summon is honoured only from a
non-guest `OWNER` or `EDITOR`) treats an absent or unknown value as a refusal.

### Client → server

| Byte | Name | Payload | Who | Server does |
|---|---|---|---|---|
| `0x01` | `UPDATE` | `bytes`: one Yjs update (v1) | EDITOR, OWNER | appends with the next `seq`, sends `ACK(seq)` to the sender and `UPDATE(seq, bytes)` to every other session of the board |
| `0x02` | `AWARENESS` | `bytes`: a y-protocols awareness update with **exactly one** entry | everyone | checks the entry (below), sends `AWARENESS(From, bytes)` to every other session |
| `0x03` | `PING` | none | everyone | answers `PONG` |

Awareness check (S2.6): the payload is `varuint count`, then per entry
`varuint clientID`, `varuint clock`, `varstring state` (JSON or `null`).
`count` must be 1. The first awareness frame of a session binds its
`clientID`; later frames with another `clientID` are dropped. A session has
exactly one Yjs `clientID` for its whole life (a reconnect is a new session).

### Server → client

| Byte | Name | Payload | When |
|---|---|---|---|
| `0x80` | `WELCOME` | `varstring` JSON `{"role": "EDITOR", "self": From, "limits": {"update": 1048576, "awareness": 16384}}` | first frame of every session |
| `0x81` | `SNAPSHOT` | `varuint upToSeq`, `bytes` snapshot | after `WELCOME`, only if the board has a snapshot |
| `0x82` | `UPDATE` | `varuint seq`, `bytes` update | during join (every log entry after the snapshot, ascending), then for every update another session sent |
| `0x83` | `SYNCED` | `varuint headSeq` | after the join frames; from here on the client is in sync with `headSeq` (0 = empty board) |
| `0x84` | `ACK` | `varuint seq` | to the sender of an accepted `UPDATE`, in the order the updates arrived |
| `0x85` | `AWARENESS` | `From`, then `bytes` (the payload as sent) | another session sent awareness |
| `0x86` | `PEER_JOINED` | `From` | another session joined; every client answers by sending its current awareness state once |
| `0x87` | `PEER_LEFT` | `From` | another session closed; clients remove the awareness state of `From.clientId` at once |
| `0x88` | `COMPACT` | `varuint upToSeq` | the server asks this client for a snapshot (below) |
| `0x89` | `PONG` | none | answer to `PING` |
| `0x8A` | `ROLE` | `varstring` JSON `{"role": "VIEWER"}` | the user's role on the board changed while the session is open (sharing, M2) |

Unknown message types are a protocol error in both directions within
`drawboard.v1`.

### Roles per message (S2.4)

`UPDATE` from a `VIEWER` or `COMMENTER` session is dropped, not appended, and
counted; after 10 dropped messages the server closes with 4403. A client that
is not an editor (role in `WELCOME`/`ROLE`) does not send updates at all and
keeps its document read-only.

## Client behaviour

* **Applying:** updates from the server are applied with the provider as
  transaction origin, so they are not sent back.
* **Sending:** every local transaction produces a Yjs update; the client puts
  it into a **pending queue** and, while connected and synced, sends it as
  `UPDATE`. Each `ACK` removes the oldest pending entry.
* **Reconnect:** after `SYNCED` the client merges the whole pending queue into
  one update (`Y.mergeUpdates`), replaces the queue by it and sends it. So
  edits made offline or lost in a broken connection arrive exactly once more
  (duplicates are harmless).
* **Malformed entries:** an `UPDATE` or `SNAPSHOT` that Yjs cannot apply is
  skipped (its `seq` still counts as seen), reported once, and the client
  carries on; one bad log entry must never make a board unjoinable (S2.13).
* **Backoff:** 1 s, doubling to 30 s, ±20 % jitter; reset after 10 s connected.
  Close codes below say when not to reconnect.
* **Keep-alive:** the client sends `PING` every 30 s and reconnects when no
  `PONG` came for 60 s. The server closes a session that sent nothing for
  5 minutes (4408, S2.11).
* **Awareness:** `y-protocols/awareness` with the document's `clientID`; the
  client sends its state on change (throttled to 10/s), when `PEER_JOINED`
  arrives, and every 15 s. States older than 30 s are removed.

## Compaction (S2.8)

When a board's log since the last snapshot is larger than 1 MiB or has more
than 500 entries, and the last compaction request of the board is at least
60 seconds old, the server picks one connected session of a signed-in
(non-guest) `EDITOR` or `OWNER` and sends `COMPACT(upToSeq)` with its
current `headSeq`. The request stays open for 2 minutes, one per board.

The client answers only if its pending queue is empty and it has applied
everything up to `upToSeq` (it has, once it received those `UPDATE`s): it
uploads `Y.encodeStateAsUpdate(doc)` with
`PUT /api/boards/{boardId}/snapshot?upToSeq=<upToSeq>` (multipart field
`snapshot`). Otherwise it ignores the request; the server asks again later,
possibly another client. The snapshot may contain more than `upToSeq` (later
updates already applied) — harmless, because joins replay the log after
`upToSeq` anyway.

The server checks the open request before it reads the upload body, and
accepts at most 10 snapshot uploads per user and minute (429).

The server keeps the last 5 snapshots or all snapshots of the last 7 days,
whichever is more, as long as the kept snapshots of the board stay within
their byte budget (500 MB); the newest 5 are always kept. It also keeps every
log entry after the oldest kept snapshot.

## Version restore (S2.8)

The kept snapshots are the board's versions (`GET /api/boards/{boardId}/versions`).
When the owner restores one (`POST /api/boards/{boardId}/versions/{versionId}/restore`),
the server replaces the document by that snapshot and closes **every** open
session of the board with close code **4410 "document replaced"**.

A client that receives 4410 throws away its local `Y.Doc` and its pending
queue, creates a fresh document and joins again (new ticket); the join
delivers the restored state. It must not merge its old local state or resend
pending updates: Yjs merges are additive, so the old state would bring the
replaced content straight back. Edits that were not acknowledged before the
restore are lost on purpose.

A client built before 4410 existed does not know the code and would reconnect
and merge its old state back; version restore is therefore offered only with
a frontend that implements 4410 (same release, M2).

4410 is an additional close code within `drawboard.v1`; the frames are
unchanged.

## Limits (S2.5, S2.7)

| What | Limit | Reaction |
|---|---|---|
| `UPDATE` frame | 1 MiB | close 1009 |
| `AWARENESS` frame | 16 KiB | close 1009 |
| Updates per session | 60/s, burst 200 | sustained excess: close 4429 |
| Awareness per session | 30/s | sustained excess: close 4429 |
| Sessions per user | 20 | handshake answers 429 |
| Sessions per board | 200 | handshake answers 429 |
| Snapshot | 50 MB | REST 413 |
| Kept snapshots per board | 500 MB (counted toward the board size) | REST 413 |
| Compaction requests per board | 1 per 60 s | – |
| Snapshot uploads per user | 10/min | REST 429 |
| Outbound queue per session | 16 MiB | close 1011 |
| `From.name` | 64 characters | truncated by the server |
| Log per board (since the oldest kept snapshot) | 100 MB | update rejected, close 4413 |
| Inflated frame | `permessage-deflate` is off | – |

Limits are configurable on the server; the effective frame limits are sent in
`WELCOME`.

## Close codes

| Code | Meaning | Client reaction |
|---|---|---|
| 1000 | normal close (client left, board closed) | – |
| 1001 | server shutting down | reconnect with backoff |
| 1009 | frame too large | do not resend that update; reload the board |
| 1011 | server error | reconnect with backoff |
| 4400 | protocol violation | reconnect once, then show an error |
| 4401 | token behind the ticket expired | new ticket, reconnect at once |
| 4403 | access lost, or too many forbidden messages | do not reconnect; reload board metadata (404/403 decide what to show) |
| 4404 | board deleted | do not reconnect; leave the board |
| 4408 | idle timeout | reconnect with backoff |
| 4410 | document replaced (an owner restored a version) | discard the local document **and** the pending queue, create a fresh `Y.Doc`, get a new ticket and join at once; never merge the old local state back |
| 4413 | board too large | do not reconnect for editing; show "board is full" |
| 4429 | rate limit or session limit | reconnect after 30 s |

## Example

```
C: (handshake, subprotocols drawboard.v1, ticket.Zm9v…)
S: WELCOME {"role":"EDITOR","self":{"id":"…","name":"Alice","guest":false,"color":"#e8590c"},"limits":{…}}
S: SNAPSHOT upToSeq=120 <bytes>
S: UPDATE seq=121 <bytes>
S: UPDATE seq=122 <bytes>
S: SYNCED headSeq=122
C: AWARENESS <1 entry, clientID 42>      → others get AWARENESS From{…, clientId 42}
C: UPDATE <bytes>                         → S: ACK 123; others get UPDATE 123
S: COMPACT upToSeq=500
C: PUT /api/boards/…/snapshot?upToSeq=500 → 204
```
