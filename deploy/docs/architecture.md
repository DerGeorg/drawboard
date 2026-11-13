# Drawboard — architecture concept

Status: draft, 2026-11-09. Self-hosted, collaborative whiteboard (Miro alternative)
on the house stack: Spring Boot 4 / Kotlin backend, Angular 22 frontend,
OpenAPI contract, GitLab pipelines, Grafana via Alloy.

## 1. Goals

| # | Requirement | Phase |
|---|---|---|
| 1 | Login via OIDC (Authelia directly, Keycloak works too) | M0 |
| 2 | Docker image(s) and a Helm chart | M0 / M2 |
| 3 | Live collaborative editing with cursors and presence | M1 |
| 4 | Boards stored per user, in folders; sort, move, rename | M2 |
| 5 | Share boards and folders with users, groups, or a link (guests without an account) | M2 |
| 6 | Export a board as a file or as a data URL; import both | M2 |
| 7 | Plugin interface, also for third-party plugins | M3 |
| 8 | Mermaid block: drag in like a sticky note; import `.mmd`, export `.mmd`/SVG/PNG | M3 |
| 9 | File embeds: images, video, PDF (single page or whole document), Word/Office via PDF conversion | M3 |
| 10 | Basic kanban (columns, cards, assignee, due date, labels) | M4 |
| 11 | Scrum story cards and planning poker | M4 |
| 12 | Usage stats in Grafana | M1 onwards |

## 2. Repositories

Same layout as the other apps (`sail`, `signalbox`):

```
apps/drawboard/
  api/        OpenAPI contract (REST only); npm package + Kotlin jar
  backend/    Spring Boot 4, Kotlin, WebFlux + R2DBC, hexagonal modules
  frontend/   Angular workspace:
                projects/app            the Angular app
                projects/board-engine   framework-free TypeScript: Yjs model, viewport, hit testing, tools
                projects/plugin-sdk     published npm package for plugin authors
  deploy/     Helm chart, compose files for Portainer
  docs/       this file, ADRs, collaboration protocol
```

## 3. Big decisions

### 3.1 Collaboration: Yjs, relayed by the Kotlin backend

Yjs is the de-facto CRDT for collaborative editors (MIT, offline support,
awareness for cursors, undo manager). There is **no maintained Yjs
implementation on the JVM** (y-crdt has Rust, WASM, Python, Ruby, .NET, but
no Java binding). Options:

| Option | Pro | Con |
|---|---|---|
| **A. Kotlin relay, opaque updates (chosen)** | One stack, one deployment; auth and ACL in one place; no CRDT logic on the server | Server cannot read board content; compaction and summaries come from clients |
| B. Node sidecar (Hocuspocus / y-websocket) | Server understands the document | Second runtime, auth split across two services |
| C. Rust sidecar (y-sweet) | Fast, server understands the document | Same as B, plus a third language |

How option A works:

* Per board: a binary **update log** (append-only rows) plus the latest
  **snapshot** (`Y.encodeStateAsUpdate`). Yjs updates are commutative and
  idempotent, so the server never has to merge them.
* Join: server sends snapshot + log tail. Edit: client sends an update, the
  server checks the role (viewer updates are rejected), appends, broadcasts.
* Compaction: when the log exceeds a threshold, the server picks one
  signed-in (non-guest) editor client and asks it for a new snapshot covering
  sequence N, uploaded over REST (`PUT /api/boards/{id}/snapshot`). The server
  keeps the last 5 snapshots or 7 days plus the log, because it cannot
  validate a client snapshot; owners can restore a version (S2.8).
* The snapshot upload carries a small **board summary** (title, block counts
  per type, plain text for search, thumbnail PNG). This feeds search, folder
  previews and the Grafana stats without the server parsing Yjs.
* Awareness (cursors, selection, names) is relayed, never stored; the
  server wraps every awareness frame with the sender identity it
  authenticated, clients render names only from that wrapper (S2.6).
* WebSocket authentication with a one-time ticket in `Sec-WebSocket-Protocol`,
  sessions end when the token behind the ticket expires (S2.1–S2.3).
* Scaling: one replica first. More replicas later via PostgreSQL
  `LISTEN/NOTIFY` fan-out (R2DBC supports it), no Redis needed.

Escape hatch: if we ever need server-side document logic (e.g. server-side
export rendering), option B can be added behind the same protocol.

### 3.2 Canvas: own engine, not tldraw or Excalidraw

| Option | Why not |
|---|---|
| tldraw | Production use needs a license key; the free hobby license keeps the "made with tldraw" watermark, removing it needs a business license. React only. |
| Excalidraw | MIT and has Mermaid import, but React only, own element model (no rich blocks like kanban, PDF, video), collaboration not Yjs-based, little room for a plugin API. |
| **Own engine (chosen)** | Full control over blocks, plugins and data model. |

**Rule (Georg, 2026-11-09): the canvas stays open source without license
keys or fees.** Only permissive licenses (MIT, Apache-2.0, BSD, ISC) for
everything in the board: Yjs (MIT), perfect-freehand (MIT), mermaid (MIT),
pdf.js (Apache-2.0), Gotenberg (MIT). If no such library fits, we build it.

Rendering is **DOM-based** (like tldraw does internally): one world container
with a CSS transform for pan/zoom, every block is an absolutely positioned
element, connectors and freehand strokes in an SVG layer. That makes rich
blocks (video, PDF page, kanban, iframe plugins) trivial; viewport culling
keeps thousands of blocks fast. Freehand via `perfect-freehand` (MIT).

The engine is plain TypeScript (`board-engine`), Angular only renders blocks
and chrome. Plugins therefore never need Angular.

### 3.3 Data model (inside the Yjs document)

```
Y.Doc
  meta: Y.Map            title, background, grid, schemaVersion
  blocks: Y.Map<id, Y.Map>
    id, type ("core.sticky", "core.mermaid", "acme.timer"…),
    x, y, w, h, rotation, z (fractional index), parent (frame/kanban), locked,
    props: Y.Map          type-specific, owned by the block type / plugin
    text?: Y.Text         rich text where the block has text
  connectors: Y.Map<id, Y.Map>   from/to block + anchor, style, label
  strokes: Y.Map<id, Y.Map>      freehand points, style
```

Every built-in block (sticky, text, shape, frame, image, mermaid, kanban,
story card) is registered through the same plugin API as third-party blocks.

### 3.4 Auth: Keycloak by default, any OIDC provider by configuration

Decision (Georg, 2026-11-09): default deployment uses the central Keycloak
(house standard), but **the code only speaks standard OIDC**, so a deployment
can bind any provider (Authelia directly, Entra ID, Zitadel …) through
environment variables alone. No Keycloak-specific library or API anywhere.

* Frontend: authorization code flow with PKCE via a generic OIDC client
  (`angular-auth-oidc-client`) behind the house `Auth` abstraction.
  Deviation from the skill (keycloak-angular) for exactly this reason.
  Issuer, client id and scopes come from `/config.json`.
* Backend: resource server, JWT validation against `OIDC_ISSUER_URI`
  (optional `OIDC_JWK_SET_URI`). **`OIDC_AUDIENCE` is required** (S6.2):
  without it, tokens the same provider issued for other clients would be
  accepted. The provider must issue JWT access tokens with `aud`
  (Keycloak: audience mapper; Authelia: `access_token_signed_response_alg`).
* **Permissions do not come from token roles** but from the app's own ACL
  (section 3.5); this works with every provider.
* The only provider-specific bit is configuration: which claims carry
  username, display name, email and groups, and which claim value makes
  someone an instance admin:
  `OIDC_CLAIM_USERNAME` (default `preferred_username`),
  `OIDC_CLAIM_GROUPS` (default `groups`; Keycloak: a groups mapper or
  `resource_access.drawboard-api.roles`),
  `DRAWBOARD_ADMIN_GROUP` (value in that claim; evaluated per request from
  the current token, empty = nobody is admin, S6.6).
* Users are known after their first login (profile cached from `sub`,
  `preferred_username`, `email`, `groups`), so others can find and share with them.
* **Guests** (link sharing): the link carries a random token in the URL
  fragment; the backend exchanges it for a short-lived, app-signed guest JWT
  (ES256) scoped to exactly that board or folder and role. The guest picks a
  display name. The backend accepts two issuers from a fixed list: the OIDC
  provider and itself. Guest links are an explicit opt-in per link and per
  instance (`DRAWBOARD_GUESTS_ENABLED=false` by default); details S1.

### 3.5 Storage, folders, sharing

* PostgreSQL 18, one schema per module.
* Every user has a personal space; folders form a tree; boards live in a folder.
* ACL entries on folder or board: principal (user, group, link) → role
  (`owner`, `editor`, `commenter`, `viewer`). Folder entries inherit
  downwards; the strongest role wins.
* Link shares: role, optional expiry, optional password, revocable, usage counted.
* "Shared with me" view next to "My boards".

### 3.6 Files and embeds

* Storage port with two adapters: filesystem (volume / PVC) and S3-compatible.
* Served only through short-lived signed URLs from the API (S4.4); the Yjs
  document holds only the `fileId`. Type allowlist by content sniffing, SVG
  rejected (S4.2, S4.3).
* Images: stored as uploaded plus a server-side thumbnail.
* Video: streamed with HTTP range requests, no transcoding.
* PDF: rendered in the browser with pdf.js; block shows one page or a pager over all pages.
* Word, PowerPoint, Excel, ODF: converted to PDF on upload by a **Gotenberg**
  sidecar (LibreOffice in a container, MIT), then treated like PDF; the original stays downloadable.
* Limits per file and per user configurable; content type sniffed on the server,
  never trusted from the client; files served from a separate path with
  `Content-Disposition` and a strict CSP.

### 3.7 Mermaid

* Block `core.mermaid` in the toolbar like a sticky note; edit the source in a
  side panel with live preview; rendered by `mermaid` (lazy chunk,
  `securityLevel: 'strict'`).
* Import: drop or paste a `.mmd` file or a ```` ```mermaid ```` fence → new block.
* Export per block: `.mmd`, SVG, PNG.
* Later (optional): convert a mermaid flowchart into native, editable blocks
  and connectors, and native flowcharts back to mermaid.

### 3.8 Plugin interface

* A plugin = manifest (`id`, `version`, block types, toolbar items,
  import/export handlers, requested capabilities) + an ES module bundle.
* SDK (`@apps/drawboard-plugin-sdk`): `defineBlock({ type, defaultSize,
  props schema, render(el, ctx), onEdit, toMermaid?, fromFile? })`, events,
  read access to the board for export plugins, typed `props` access.
* Built-in blocks use the same SDK, which keeps the API honest.
* Two trust levels:
  * **trusted**: only blocks built into the frontend image (own code, SBOM,
    release); they run in the page as Web Components;
  * **everything installed at runtime** runs in a sandboxed iframe
    (`sandbox="allow-scripts"` only) and talks to the board over a
    `MessageChannel`, only with the capabilities the admin granted. There is
    no switch to promote a plugin to trusted (S3.1).
* Plugins are installed per instance by the admin (upload only in M3),
  versioned, can be disabled. Unknown block types render as a placeholder,
  data is kept.

### 3.9 Export and import

* **File** `.drawboard`: ZIP with `board.json` (readable JSON of the document,
  schema version), `snapshot.yjs`, and the embedded files.
* **Data URL**: `https://<host>/open#v1.<base64url(deflate(board.json))>`. The data
  sits in the fragment, so it never reaches a server. Without embedded files
  (references only), ≤ 1 MB compressed. Opening needs a login; the recipient
  sees a read-only board marked "opened from a link, not saved" and can save
  a copy.
* Import of both formats runs entirely in the browser and rebuilds the board
  from `board.json` with schema validation; `snapshot.yjs` is never loaded on
  import (S5.5, S5.6).
* Also: PNG, SVG and PDF of the whole board or a frame.

### 3.10 Kanban and scrum

* `core.kanban` block: columns, cards with title, assignee (board member),
  due date, labels, story points; drag cards between columns and out onto the canvas.
* `core.story` card: title, description, acceptance criteria, estimate.
* Planning poker: facilitator starts a round on a story card, everyone votes
  over REST, votes stay on the server and are **not** in the Yjs document
  (every client could read them there); the reveal writes the result to the
  card (S7.6).

### 3.11 Metrics for Grafana

Pushed via OTLP to Alloy → Prometheus (house standard, `spring-kotlin-monitoring`):

| Metric | Type |
|---|---|
| `drawboard_boards` (by owner type) | gauge |
| `drawboard_users_active` (24 h / 7 d / 30 d) | gauge |
| `drawboard_collab_sessions` (open WebSockets), `drawboard_collab_rooms` | gauge |
| `drawboard_collab_updates_total`, `drawboard_collab_update_bytes` | counter / histogram |
| `drawboard_blocks` by type (from board summaries) | gauge |
| `drawboard_storage_bytes` by kind (snapshot, log, files) | gauge |
| `drawboard_uploads_total`, `drawboard_conversions_total` by result | counter |
| `drawboard_share_links_active`, `drawboard_guest_sessions` | gauge |
| `drawboard_exports_total` by format, `drawboard_imports_total` | counter |

Plus the standard HTTP/JVM/R2DBC metrics, traces and logs, and Faro in the
frontend. A generated service dashboard plus a "Drawboard usage" dashboard.

### 3.12 Templates (M5)

* A template is a normal board with `Board.template = true`: same folder, sharing and
  editing. Only the owner switches the flag. `listTemplates` lists every template the
  caller may open (own, shared directly, by group, by link, inherited from a folder).
* **A new board from a template is a copy made in the browser**, the same path as an
  import (3.9): read the template's document over the collaboration connection,
  `boardToFile`, `createBoard`, write the pieces. No server-side copy, so the board
  document stays opaque to the backend. Later changes of the template do not reach
  the copies.
* Files on a template (images, PDFs) belong to the template board (S4.1). The copy
  downloads each through its signed URL and uploads it to the new board, then points
  the block at the new file id; a file that cannot be copied leaves the block showing
  "not available".
* "Save as template" on any board makes a template copy (the retro board stays as it
  was); "Use template" is in the new-board dialog and on the Templates page.
* **Built-in templates** ship in the frontend image as typed board files, validated by
  `parseBoardFile` in a test: retros (Start/Stop/Continue, Mad/Sad/Glad, 4L), Kanban,
  Sprint planning, Brainstorming, User story map, SWOT.

### 3.13 Emojis (M5)

* The system's emoji font draws them; no emoji images are shipped (Twemoji and Noto
  graphics are not under a permissive licence, see the rules of the project).
* Picker: own Angular component, emoji data from `emojibase-data` (MIT), loaded as a
  lazy chunk on first use, served from the app (no CDN). Recently used emojis in
  localStorage (per browser, best effort).
* In text: a button while a text is edited inserts at the caret.
* `core.emoji` block (stamp): props `{ emoji }`, validated on import and paste like every
  other prop (one emoji, at most 32 UTF-16 units, no whitespace or control characters),
  rendered as text only. Used for reactions and dot voting in retros.

## 4. Backend modules

```
core       app class, route table, OTel, Flyway, clock
api        controllers for the generated contract interfaces
shared     toolbox (error, security, logging, types …)
auditing   audit trail (house standard)
users      user directory from OIDC logins, groups, admin flag
library    folders, boards metadata, ACL, share links
collab     WebSocket relay, update log, snapshots, awareness, compaction
files      uploads, storage port, thumbnails, Gotenberg conversion
plugins    plugin registry, manifests, bundles
```

`collab` and `library` must not know each other (house rule); the access check
for a room goes through a port that `api`/`core` wires to `library`.

## 5. Deployment

* **Production runs on Portainer first** (compose, files on a volume); the Helm
  chart is built alongside and tested in the Kubernetes lab (decided 2026-11-09).
* **Two images** built by the house pipeline components (`spring-image`,
  `angular-image`); chart and compose deploy both together (decided 2026-11-09).
* Helm chart in `deploy/helm/drawboard`: backend, frontend, optional Gotenberg,
  PostgreSQL either external (default) or via a dependency, PVC or S3 for files,
  Ingress with WebSocket support, ServiceMonitor-free (OTLP push).
* Compose file for Portainer next to it.

## 6. Phases

| Phase | Content | Done when |
|---|---|---|
| M0 | Repos, contract, backend and frontend from the samples, OIDC login (local Keycloak in compose; Authelia only by configuration), compose, pipelines, images | Logged-in user sees an empty "My boards" page in the deployed image |
| M1 | Board engine (pan/zoom, select, move, resize, undo), sticky, text, shapes, connectors, freehand; collaboration with cursors; persistence; base metrics | Two browsers edit the same board live, reload keeps everything |
| M2 | Folders, ACL, user/group/link sharing, guests, export/import file + data URL, Helm chart | A guest opens a link without an account and edits |
| M3 | Plugin SDK + built-ins moved onto it, mermaid block, uploads (image, video, PDF, Office via Gotenberg) | An external sample plugin works in the sandbox |
| M4 | Kanban, story cards, planning poker, usage dashboard, hardening | Sprint planning on a board works end to end |
| M5 | Emoji picker and stamps, templates (own, shared, built-in) | A team runs its retro from a shared template and reacts with emojis |

## 7. Open points

* Token introspection mode for providers without JWT access tokens (S6.3, not before M2).

## 8. Security decisions

Binding result of the security review (Fable, 2026-11-09). Referenced
elsewhere as S<area>.<n>. MUST = required, SHOULD = recommended. These
decisions are not overruled by a smaller model; a change needs a new review.

**Verdict:** the architecture is a sound basis. Mandatory changes are built
into the sections above: audience required, "trusted" only for built-in
plugins, signed file URLs, WebSocket ticket, guests opt-in and upload-free,
import in the browser, poker votes over REST, Gotenberg without egress,
snapshot versions kept, telemetry never sends URL fragments.

### S1 Guest access via share links (M2)

1. MUST Link token: 256 bit from `SecureRandom`, base64url. The DB stores only `sha256(token)`; lookup by hash.
2. MUST Token in the URL fragment (`/s#<token>`), never path or query; the frontend sends it in the body of `POST /api/shares/exchange`. `Referrer-Policy: no-referrer`.
3. MUST Exchange returns an app-signed guest JWT, ES256 or EdDSA, never HS*. Claims: `iss` = `<DRAWBOARD_PUBLIC_URL>/guest` (startup fails if it equals `OIDC_ISSUER_URI`), `sub` = `guest:<random>`, `aud` = `OIDC_AUDIENCE`, `typ` = `guest`, `share`, `res` (resource id + kind), `role`, `name` (sanitised, ≤ 64 chars), `pw`, `auth_time`, `exp`, `jti`.
4. MUST Lifetime 15 min; refresh via `POST /api/shares/refresh` with valid guest JWT + link token; hard limit 12 h from `auth_time`. Every exchange/refresh re-checks revocation, expiry, role; `exp` ≤ min(now + 15 min, share expiry).
5. MUST Keys from `DRAWBOARD_GUEST_SIGNING_KEYS` (PEM list from a secret; first signs, all verify), `kid` = public key fingerprint. Rotation: prepend new key, remove old after 12 h.
6. MUST Two issuers via `JwtIssuerReactiveAuthenticationManagerResolver.fromTrustedIssuers(oidcIssuer, guestIssuer)` with a fixed list. One decoder per issuer with algorithm allowlist, exact `iss`, required `aud`, `exp`/`nbf` skew ≤ 60 s; the guest decoder requires `typ = guest`.
7. MUST Guests are their own principal type (`GuestPrincipal`); authorisation branches on the type; every guest request checks the resource is `res` or below it.
8. MUST Route allowlist for guests, rest `denyAll`: read board, collab ticket, file URLs of that board, board list of a shared folder (title + thumbnail), refresh. No user directory, upload, folder/ACL/share management, admin/plugin routes, server export.
9. MUST Guests upload no files (M2). Later only with owner opt-in per share and quota on the owner (SHOULD, not before M4).
10. MUST Guests see only display names of present participants, never emails, member lists or search results. The server marks guests (`guest: true`); a guest cannot impersonate a registered name.
11. MUST Link password: `Argon2PasswordEncoder`, ≥ 8 chars, POST body only. 5 failures/min per share+IP, 20/h per share, then 429 with growing delay; never lock the share. Every failure is an audit event. (refined in the M2 review below)
12. MUST Invalid token exchange: 10/min per IP, generic 404 for unknown, revoked and expired alike.
13. MUST Revocation: `revoked_at` on the share; guest REST requests re-check the share (cache ≤ 30 s); `library` publishes `ShareRevoked` through a port, `collab` closes affected sessions (4403). (refined in the M2 review below)
14. MUST Two link types: "anyone signed in with the link" (default) and "guests without account allowed" (explicit). Instance switch `DRAWBOARD_GUESTS_ENABLED=false` by default until the checklist below is done. (refined in the M2 review below)
15. SHOULD Link roles limited to viewer, commenter, editor; never owner.

### S2 WebSocket collaboration (M1)

1. MUST One-time ticket: `POST /api/boards/{id}/collab-ticket` (bearer) returns 256 bit random, valid 30 s, single use, bound to principal, board and the token's `exp`. Client sends `Sec-WebSocket-Protocol: drawboard.v1, ticket.<ticket>`; server selects `drawboard.v1`. No ticket in the query string, no auth-as-first-message.
2. MUST Handshake redeems the ticket, resolves the role again through the `library` port, checks `Origin` equals `DRAWBOARD_PUBLIC_URL` exactly (else 403); missing/wrong subprotocol → 400. `DRAWBOARD_PUBLIC_URL` is validated at startup as scheme + host (+ port), nothing else; without default port (`:443`/`:80`), browsers omit it in `Origin`.
3. MUST A session ends at the latest with the `exp` of the token behind its ticket (4401); the client gets a new ticket and reconnects. `AclChanged`, `ShareRevoked`, `UserDisabled` re-evaluate affected sessions at once (downgrade or 4403); safety net: ACL re-check every 60 s. The expiry check runs in the maintenance sweep; a session may outlive `exp` by at most the sweep interval (≤ 5 s). (refined in the M2 review below)
4. MUST Role per message type: sync-step1/2 (all), update (editor/owner only), awareness (all), ping. Forbidden messages are dropped and counted; 10 violations → 4403. Snapshots never go over the WebSocket.
5. MUST Limits per session: update ≤ 1 MiB, awareness ≤ 16 KiB (else 1009); 60 updates/s (burst 200), 30 awareness/s (sustained excess → 4429). Max 20 sessions per user, 200 per board, 50 per IP for guests. `permessage-deflate` off or a hard limit on the inflated frame size. The outbound buffer per session is bounded in bytes (≤ 16 MiB) as well as frames; above it 1011. The 16 MiB count frames handed to the socket layer; its own write prefetch (≤ 256 frames) comes on top until the bytes are released on write completion (SHOULD).
6. MUST The server wraps every relayed awareness frame as `{from: {id, name, guest, color?}, payload}` from the authenticated principal; clients render names only from it. Exactly one Yjs `clientID` per session; frames with several or foreign client entries are dropped. `From.name` ≤ 64 chars for every principal (signed-in and guest).
7. MUST Board size: snapshot ≤ 50 MB, log ≤ 100 MB (configurable), above that updates are rejected (4413). Metric and alert on `drawboard_storage_bytes`. Per board: log ≤ 100 MB (4413 on updates) and kept snapshots ≤ 500 MB (413 on upload), each enforced separately (decision Georg, 2026-11-09); compaction at most once per 60 s per board; the 7-day rule is bounded by the snapshot budget.
8. MUST Compaction only by non-guest editors chosen by the server, over REST with sequence N and size cap. Keep the last 5 snapshots or 7 days plus log; owners can restore a version. The server checks the open compaction request (user, `upToSeq`, time) before it reads the upload body; snapshot uploads are rate-limited per user (S7.3). The multipart body may be spooled to a size-capped temp directory before the check (≤ 51 MB per request via nginx `client_max_body_size`, a MUST on that route; the temp directory is a size-limited, disk-backed volume, not an unbounded tmpfs); before production the per-user limit runs before the body is read at all (WebFilter or raw body). (refined in the M2 review below)
9. MUST Validate the board summary: title ≤ 200 chars, counters non-negative ints, search text ≤ 256 KB; thumbnail: PNG magic, header dimensions ≤ 1024 px before decoding, pixel cap, re-encode to ≤ 512 px / ≤ 200 KB without metadata; served like files (S4.5).
10. MUST Search over summary texts filters by ACL before matching.
11. SHOULD Idle timeout 5 min without pong; close codes documented in the collaboration protocol.
12. SHOULD `LISTEN/NOTIFY` fan-out carries only row ids, never update content.
13. SHOULD in M1, MUST from M2: clients tolerate a malformed update or snapshot from the log: skip it, report once, continue; a single bad entry must not make a board unjoinable.

### S3 Plugin system (M3)

1. MUST `trusted` only for blocks built into the frontend image. Everything installed at runtime always runs sandboxed. No promote switch.
2. MUST iframe `sandbox="allow-scripts"` and nothing else; `allow=""`, `referrerpolicy="no-referrer"`, `loading="lazy"`, mounted only in the viewport, max 50 plugin blocks at once.
3. MUST Plugin documents also get the response header `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src <plugin-assets-origin>; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src <granted hosts, default none>; frame-ancestors <app-origin>; base-uri 'none'; form-action 'none'` plus `nosniff`.
4. SHOULD Own hostname for plugin assets (`DRAWBOARD_PLUGIN_ORIGIN`); without it `/plugin-assets/` on the app host, then S3.2 and S3.3 carry alone.
5. MUST Assets immutable under `/plugin-assets/<pluginId>/<version>/<sha256>/…`, `Cache-Control: immutable`, CORS `*` only on that path, without credentials; bundles hold no secrets.
6. MUST The host generates the iframe bootstrap HTML and loads the plugin module with `integrity="sha384-…"` computed at install; hash and installer in the audit event.
7. MUST One `MessageChannel` per plugin instance; every message validated against a schema (`type`, `v`, `requestId`), unknown → dropped and counted, payload ≤ 256 KB, 100 messages/s. The host never executes plugin strings, no `innerHTML` with plugin data.
8. MUST Capabilities (declared in the manifest, granted by the admin, default off): `block.props` (own `<pluginId>.*` types only), `block.resize`, `board.read` (structure + text of the current board, no emails), `export.register`, `import.register(<mime>)`, `ui.toast`, `ui.openLink` (target host shown, `noopener`), `storage` (KV per plugin + board, ≤ 1 MB), `network(<hosts>)` (only as `connect-src`). User info: display name + pseudonymous id `hmac(userId, pluginId)`. Never: tokens, API proxying with user credentials, DOM access, other boards, file upload.
9. MUST Install by instance admins only, in M3 by upload only (ZIP ≤ 20 MB, ≤ 200 entries, unpacked ≤ 50 MB, no `..`/absolute paths, manifest schema, `id` = namespace of all its block types). Install by URL later only with SSRF protection (https, resolved-IP check against private ranges, pinned connection, timeout, size cap).
10. MUST Disabling removes all its iframes at once; unknown block types stay placeholders, data kept.
11. SHOULD Plugin blocks visibly framed with a badge "Plugin: <id>"; the host never asks for credentials inside the canvas.
12. SHOULD `require-trusted-types-for 'script'` in the main app from M4.

### S4 File uploads and serving (M3)

1. MUST Upload only for signed-in editors/owners of the target board; every file belongs to exactly one board, access = board access. Streamed with a hard byte cap regardless of `Content-Length`; defaults 50 MB (image/PDF/Office), 500 MB (video); quota per user and board; nginx `client_max_body_size` to match.
2. MUST Server-side type detection (Tika detector or magic bytes) against an allowlist: png, jpeg, gif, webp, mp4, webm, pdf, OOXML/ODF. Else 415. Extension must match. Stored name = UUID; original name only in the DB (sanitised, ≤ 255) and in `Content-Disposition` (RFC 5987).
3. MUST `image/svg+xml` rejected (M3); later only with an own files origin and sandbox CSP (SHOULD, not before M4).
4. MUST Delivery through signed URLs `GET /files/{fileId}?exp=<unix>&sig=<hmac-sha256(fileId|exp)>`, ≤ 1 h, keys `DRAWBOARD_FILE_URL_KEYS` (list, rotation like S1.5). Issued by `GET /api/boards/{id}/files/urls?ids=…` after the board access check. Not IP-bound.
5. MUST Headers on `/files/*`: `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=3600`, `Cross-Origin-Resource-Policy: same-origin` (`same-site` with own origin); `Content-Disposition: attachment` for everything except `image/*`/`video/*`.
6. SHOULD Own files origin (`DRAWBOARD_FILES_ORIGIN`) as a second line of defence.
7. MUST Range requests: one range per request, validated, `Accept-Ranges: bytes`.
8. MUST Thumbnails: dimensions from the header before decoding, cap 50 MP, decode with timeout in its own pool, re-encode without metadata. SHOULD strip EXIF (GPS) from JPEG originals.
9. MUST pdf.js with `isEvalSupported: false`, `enableScripting: false`, worker from `'self'`; kept current by Renovate.
10. MUST Gotenberg on an `internal: true` network (K8s: NetworkPolicy without egress), reachable only from the backend, `--chromium-disable-routes=true`, only `/forms/libreoffice/convert`, memory limit, non-root. 60 s timeout, result sniffed as PDF and size-capped; conversion queued (1 at a time per instance), 10/min per user.
11. MUST Drawboard never unpacks Office files itself; original download always `attachment` with a hint that it may contain macros.
12. SHOULD `FileScanner` port with a no-op default, ClamAV adapter optional (M4); required once guests or plugins can upload.
13. MUST Files follow the board into the trash and are removed with the hard delete; daily orphan GC.

### S5 Rich content (M1–M3)

1. MUST Mermaid `securityLevel: 'strict'`, `htmlLabels: false`, `maxTextSize: 50000`, `maxEdges: 500`; the SVG additionally goes through DOMPurify (svg profiles, forbid `foreignObject`, `script`, `a`); source ≤ 50 KB.
2. MUST Rich text rendered from the Y.Text delta with `createElement`, never `innerHTML`; HTML paste through DOMPurify into deltas; ≤ 100 k chars per Y.Text. Every CSS value read from block props passes `safeColor` or an allowlist before it reaches a style property; the CSP `img-src` is the backstop, not the control.
3. MUST Links: scheme allowlist `https:`, `http:`, `mailto:`; `target="_blank" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer"`; host shown on hover.
4. MUST External embeds only for hosts on `DRAWBOARD_EMBED_ALLOWLIST` (default empty = off), https only, click-to-load, iframe `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"`, `referrerpolicy="no-referrer"`, `allow="fullscreen"`; the allowlist becomes `frame-src` in the nginx CSP at container start.
5. MUST `.drawboard` import in the browser: ZIP ≤ 200 MB, unpacked ≤ 500 MB total and ≤ 100 MB per entry, ≤ 1000 entries, no `..`/absolute paths; board rebuilt from `board.json` (≤ 20 MB, schema-validated per block type, known `schemaVersion`, finite coordinates, ≤ 20 000 blocks); `snapshot.yjs` never loaded; embedded files go through the normal upload path.
6. MUST Data URL: compressed ≤ 1 MB, streaming inflate aborted at 10 MB, then validation as S5.5. `/open` needs a login, shows "opened from a link, not saved", opens no collab socket, loads no embeds, file URLs only through the ACL-checked API.
7. MUST Faro and all frontend telemetry never send the URL fragment or query: URLs trimmed to origin + pathname, from the first Faro integration on.
8. SHOULD Export PNG/SVG/PDF stays client-side; server-side rendering needs a new review.

### S6 OIDC binding (M0)

1. MUST Frontend: code + PKCE (S256), no implicit/hybrid, exact redirect and post-logout URIs, tokens in memory only, refresh token rotation enabled at the provider. (refined 2026-11-10: no refresh tokens, silent iframe renewal, logout ends the provider session - see "Authelia consent and refresh tokens")
2. MUST `OIDC_AUDIENCE` required, startup fails if empty. Validator: `aud` contains it, exact `iss`, algorithm allowlist RS256/ES256/PS256, skew ≤ 60 s, JWKS refresh on unknown `kid` (rate-limited). Documented: Keycloak audience mapper, Authelia `access_token_signed_response_alg: RS256`.
3. SHOULD Introspection mode (`OIDC_INTROSPECTION_URI` + client credentials) for providers without JWT access tokens; not before M2.
4. MUST Identity key `(iss, sub)`, never username or email. Email stored only with `email_verified=true`, never used to resolve shares; user shares target the internal user id.
5. MUST Group ACLs evaluated against the groups of the current access token, not the cached profile. Guest tokens have no groups.
6. MUST Admin status per request from the token (`DRAWBOARD_ADMIN_GROUP` exact); empty config = nobody is admin; effective admin config logged at startup; first admin access per user and day is an audit event.
7. MUST Admin ≠ content access; taking over ownership is an explicit, audited break-glass action.
8. SHOULD `DRAWBOARD_ADMIN_SUBJECTS` (list of `sub`) as bootstrap alternative without a groups claim.
9. MUST User search for sharing: signed-in users only (never guests), from 2 chars, max 20 hits, display name + username + avatar, no email (only admins in user management); 30/min per user. Member lists show display names; emails only to the owner.
10. SHOULD `DRAWBOARD_USER_SEARCH=all|off`.

### S7 Cross-cutting

1. MUST Audit events: first login, share created/changed/revoked, password set, exchange success/failure (share id, IP), ACL change, board created/deleted/restored, version restored, file uploaded/deleted/converted, plugin installed/enabled/disabled/removed (with hash), admin config change, compaction (who, sizes), guest session started. Never tokens, tickets, passwords, signed URLs. Retention 1 year.
2. MUST Never log `Authorization`, `Sec-WebSocket-Protocol`, query strings on `/files/*`, bodies of `/api/shares/exchange`; nginx access log without query on `/files/`.
3. MUST Rate limiting in the backend (Bucket4j, in memory per replica), 429 as problem+json: exchange/password, tickets 60/min/user, uploads 30/min/user + bytes, user search, plugin install, conversion, WebSocket. `X-Forwarded-For` only from the configured proxy. (refined in the M2 review below)
4. MUST Backend strictly stateless (no session, cookie, Basic auth), CORS on `/api` off. A cookie ever introduced = new review.
5. MUST nginx headers: CSP `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: <files-origin>; media-src 'self' blob: <files-origin>; font-src 'self'; connect-src 'self' <oidc-issuer> <files-origin> <faro-collector>; worker-src 'self' blob:; frame-src <plugin-origin> <embed-allowlist>; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` (placeholders from env at start; no bare `wss:` in `connect-src` - CSP3 `'self'` covers the same-origin WebSocket, M1 review), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, `Cross-Origin-Opener-Policy: same-origin`, HSTS `max-age=31536000; includeSubDomains`, `Cache-Control: no-store` on `index.html` and `/config.json`, `server_tokens off`.
6. MUST Planning poker votes server-side, not in the Yjs document; facilitator = owner/editor; reveal writes the result into the document.
7. MUST Boards soft-deleted (trash 30 days), then hard delete of snapshots, log, versions, files, summaries, thumbnails, shares. Deleting a user (admin): transfer or delete their boards, audited. Backups of PostgreSQL + files volume with a tested restore are an operational prerequisite.
8. MUST Secrets only via env/`_FILE`/Docker or K8s secrets, never in a checked-in compose; actuator on its own port, not exposed through the proxy; containers non-root with read-only root FS; PostgreSQL without host port in compose.
9. MUST Helm: NetworkPolicies (ingress → frontend/backend; backend → PostgreSQL, Gotenberg; Gotenberg → nothing), `runAsNonRoot`, `readOnlyRootFilesystem`, `drop: [ALL]`, ingress with WebSocket timeouts.
10. SHOULD Separate Flyway role from the runtime DB role (DML only); metric labels without PII; Faro user attribute is the internal id.
11. SHOULD Dependency-Track/Renovate as house standard, focus on mermaid, pdfjs-dist, yjs, jszip, pako, dompurify.

### M1 implementation review (Fable, 2026-11-09)

Review of the M1 code (contract `feat/collab`, backend `feat/collab-*`,
frontend `feat/board-*`) against S2, S5.2, S5.3, S5.7, S7.1–S7.4. **Verdict:
merge after the two MUST fixes** (fixes verified 2026-11-09, all eight
findings closed); residuals (a) and (b) below are SHOULD, due before production; (c) is resolved.
Protocol design and contract change are sound.
The refinements of this review are folded into S2.2, S2.3, S2.5–S2.8, S2.13,
S5.2 and S7.5 above.

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | MUST | Snapshot body (≤ 50 MB) read before the open compaction request is checked; parallel uploads exhaust the heap | Check the request before reading, consume after; upload rate limit per user |
| 2 | MUST | Compaction without minimum interval, every snapshot kept 7 days: unbounded storage per board | 60 s minimum interval, snapshot byte budget per board (10 × cap), kept snapshots count toward the board cap |
| 3 | SHOULD (MUST from M2) | One malformed update in the log makes the board unjoinable for every client | Client skips it, reports once (S2.13) |
| 4 | SHOULD | Outbound buffer bounded by frames, not bytes | ≤ 16 MiB per session, else 1011 |
| 5 | SHOULD | Display name in `From` unbounded | ≤ 64 chars |
| 6 | SHOULD | Colours from block props reach style properties unchecked (`url(...)` leaks the viewer's IP, only CSP stops it) | `safeColor` for every colour from props |
| 7 | SHOULD | `DRAWBOARD_PUBLIC_URL` not validated as an origin | Validate at startup |
| 8 | SHOULD | `connect-src` allows `wss:` to any host | Drop bare `wss:` |

Residuals after the fix review (SHOULD, before production):

* (a) The snapshot multipart body is spooled to disk before the request check
  (≤ 51 MB per request): move the per-user limit and a `Content-Length` check
  in front of the multipart reader (WebFilter) or read a raw body (S2.8).
* (b) The outbound byte bound releases on channel take, not on socket write:
  release on write completion so the 16 MiB are exact (S2.5).
* (c) Resolved 2026-11-09: kept snapshots counted toward the 100 MB log cap,
  so boards above ~20 MB stopped compacting. Georg chose two separate limits
  (log 100 MB, snapshots 500 MB, S2.7), as the contract already says.

### Deployment review: Authelia and at+jwt (Fable, 2026-11-09)

On the servers Authelia (`sso.dergeorg.at`) is the OIDC provider until the
central Keycloak exists. Its JWT access tokens carry `typ: at+jwt` (RFC 9068);
the decoder accepted only `JWT`, so every API call answered 401 and the SPA
looped through the login. Fix (backend MR !10): the type is checked in the
validator chain (`JWT`, `at+jwt` or absent; anything else 401), signature,
algorithm allowlist, issuer, time and audience unchanged. **Verdict: keeps
S6.2, merged.** The Authelia client (public, PKCE S256, code flow only, exact
redirect URIs, two_factor, RS256 access tokens with audience `drawboard-api`,
username/groups in the access token, CORS for the two Drawboard origins on
token/revocation/userinfo only) meets S6.1/S6.2/S6.4/S6.5; no MUST before prod.

SHOULD, before prod is used beyond Georg:

* S6.2 refinement: the JWK set is refetched on every unknown `kid` without a
  rate limit (Spring's `ReactiveRemoteJWKSource`) - "rate-limited" in S6.2 was
  never implemented. Use a Nimbus `JWKSourceBuilder` with cache, refresh-ahead
  and `rateLimited(30 s)`, or a kid-miss cooldown, and/or `limit_req` on the
  provider's JWKS path.
* S6.2 refinement: **one audience per environment** (`drawboard-api-dev` /
  `drawboard-api`, two clients) - today a dev access token is valid against the
  prod API. And: `OIDC_AUDIENCE` must never equal the SPA's `client_id`,
  otherwise ID tokens would pass as access tokens (a rule; the code cannot see
  the client id).
* S6.1: verify refresh-token rotation once (after a refresh the old refresh
  token must be rejected).
* Low: `response_mode: fragment` keeps the one-time code out of the SPA host's
  access log.
* S7.5 refinement: nginx answers unknown paths such as `/.env` with the SPA
  shell (200). Serve `index.html` only for extension-less paths, 404 dot-files
  and missing assets.

### M2 backend review: guests and sharing (Fable, 2026-11-10)

Review of the M2 backend stack (folders, ACL, links, guests, versions)
against S1, S2.3, S2.5, S2.8, S6.5, S6.9, S6.10, S7.1, S7.3, S7.7. **Verdict:
merge after two MUST fixes** (fixes verified 2026-11-10, all eight findings
closed; residuals: guest-session cap per IPv6 /64 and the room mutex during a
restore, SHOULD); S1.1-S1.15 otherwise met. Backend side of "Before enabling in
production" for guests is complete; the live trusted-proxy check, the signing
key as a file secret and the frontend M2 review remain.

| # | Level | Finding |
|---|---|---|
| 1 | MUST | Exchange and refresh with a *valid* token were not rate-limited (Argon2 on every call of a password link saturates the CPU) |
| 2 | MUST | Every rate-limited attempt wrote an audit row (unbounded audit growth from one blocked IP) |
| 3 | MUST (deployment) | `DRAWBOARD_TRUSTED_PROXIES` must list every hop (NPM and the frontend container) before guests are switched on |
| 4 | SHOULD | Version restore: an update could land between the dropped log and the 4410 close |
| 5 | SHOULD | No library→collab event port; the api layer calls collab after commit (accepted) |
| 6 | SHOULD | Per-IP limits must bucket IPv6 by /64 and bound the key store |
| 7 | SHOULD | The guest switch was bound to two properties |
| 8 | SHOULD | Guest name cut by UTF-16 units; the "(guest)" suffix is cosmetic - the real control is `From.guest` rendered as a badge |

Refinements:

* S1.11: limits apply to *attempts*, not only failures: every exchange/refresh
  call ≤ 30/min per IP, password verifications ≤ 10/min per share+IP (also
  correct ones), on top of the failure rules. Attempts refused by a rate
  limiter are counted in metrics, not audited (at most one audit event per block).
* S1.13: after the library committed, the api layer calls `collab.recheckAll()`
  (revoke, ACL change, move) or `closeSessions` (trash); the guest cache is
  cleared on revoke; the 60 s sweep is the safety net. `res` is
  `BOARD:<uuid>`/`FOLDER:<uuid>`.
* S1.14: one property for the switch; the signer and the API read the same value.
* S2.3: `UserDisabled` has no event source; it is bounded by the access-token
  lifetime at the provider (≤ 1 h).
* S2.8: a restore closes the board's sessions before the new base is committed.
* S7.3: per-IP limits bucket IPv6 by /64; `DRAWBOARD_TRUSTED_PROXIES` lists
  every hop in front of the backend; the limiter's key store is bounded.
* Before enabling guests in production, additionally: `DRAWBOARD_TRUSTED_PROXIES`
  set and verified (a request through the proxy is audited with the real
  client address); the guest signing key as a Docker/Kubernetes secret
  (`DRAWBOARD_GUEST_SIGNING_KEYS_FILE`); the frontend keeps the link token in
  the fragment and the guest token in memory only, refreshes before expiry,
  shows a guest badge from `From.guest`, handles 4410 - checked in the
  frontend M2 review. S4.4/S4.5 apply once file routes exist (M3).

### M2 frontend review: guests, sharing, import (Fable, 2026-11-10)

Review of the M2 frontend (`docs/m2-readme`: library, share dialog, `/s` and
guest mode, versions, `.drawboard` export/import, `/open`) against S1.2, S1.4,
S1.10, S2.13, S5.2, S5.5, S5.6, S5.7, S6.9, S7.2. **Verdict: merge after three
MUST fixes**; S1.2/S1.4 token handling, guest UI, share dialog, import limits,
4410 handling and the nginx/compose changes otherwise met.

| # | Level | Finding |
|---|---|---|
| 1 | MUST | A share link pasted on `/s` fires `popstate`; the router's deferred `replaceUrl` navigation writes `/s#<token>` back into the address bar, the history entry and `router.url` after the page stripped it (`hashchange` host listener in `guest-join.ts`) |
| 2 | MUST | `board-file.ts` looks block types up on a plain object: `type: "constructor"` resolves to `Object` and the raw props reach the document unvalidated (S5.5) |
| 3 | MUST | The context toolbar binds `selectionStyle()` colours to `[style.background]` without `safeColor` (S5.2; CSP `img-src` is the only stop) |
| 4 | SHOULD | `ApiErrorHandler` passes `router.url` (may still hold `#<token>`) as the login return URL → oidc-client-ts state store |
| 5 | SHOULD | A guest whose JWT expired before the renewal (sleep, throttled tab) ends the session and is then redirected to the identity provider by the 401 handler; 401/403 on refresh show the "12 hours" text |
| 6 | SHOULD | A board.json over 20 MB is detected but the synchronous fflate inflate cannot be terminated; `throw` from `ondata` instead. `originalSize` is undefined for data-descriptor entries, so declared-size checks are advisory |

Refinements:

* S1.2: the fragment is removed from the address bar, the history entry *and*
  the router's URL tree; the join page reads it through the router
  (`ActivatedRoute.fragment`), not a `hashchange` listener, and clears it with
  a `replaceUrl` navigation; the test goes through the real `Router`. No
  `router.url` reaches a login redirect or telemetry with a fragment.
* S1.4 (client): guest JWT and link token are private fields of one service,
  renewal 60 s before `exp` by timer and on demand, hard stop 12 h after the
  exchange; 404 ends the session as revoked, 401/403 as refused (never as the
  12 h limit); once a guest session ended, API 401s never trigger the OIDC
  login.
* S5.2: every colour that reaches a style binding in Angular templates passes
  `safeColor` as well (context toolbar, avatars, swatches), not only the
  engine's block views.
* S5.5: the type → validator lookup is `Object.hasOwn`/`Map`; `constructor`,
  `__proto__`, `toString` as block type are `ImportError`s. The only
  inflate-time limit that matters is board.json's (nothing else is ever
  inflated); the inflate aborts by throwing from `ondata`.
  Implementation note (2026-11-10): the archive also goes into the unzipper in
  4 KiB pieces - with one push a synchronous inflate expands the whole entry
  before `ondata` runs (80 MB measured), so neither CPU nor memory was bounded.
* S5.3 has no sink in M2 (no link or image blocks in the file format); it
  applies when they arrive (M3).

### M3 contract review: files and plugins (Fable, 2026-11-10)

Review of the M3 contract (api `feat/files-plugins`). **Verdict: publish as
1.3.0 after three changes** (frame CSP without `'self'`, `BoardFile.createdBy`
optional and absent for guests, verify-side cap on `exp`). Decisions:

* S1.8 (M3): guests may also call `listFiles`, `getFile` (without
  `createdBy`), `getFileUrls`, `listEnabledPlugins` and `getPluginStorage`
  (read only), each only for the board of the link or boards below its folder.
  Never upload, delete, storage writes, `/admin`.
* S3.3: the frame document's CSP names the asset location explicitly and
  path-scoped - `default-src 'none'; script-src <scheme://host><assetBase>;
  style-src <scheme://host><assetBase> 'unsafe-inline'; img-src
  <scheme://host><assetBase> data: blob:; font-src <scheme://host><assetBase>;
  connect-src <granted hosts or 'none'>; base-uri 'none'; form-action 'none';
  frame-ancestors <app origin>` plus `sandbox allow-scripts`; never `'self'`
  (opaque origin); `'wasm-unsafe-eval'` only if `.wasm` is allowed.
* S3.5: assets are resolved against the stored entry list of the install,
  never a filesystem join of the URL; `.html`/`.svg` never in a bundle;
  `__drawboard/` is reserved for the generated frame document.
* S3.8: `network` hosts: ≥ 2 labels, not `local`/`lan`/`internal`/
  `localhost`/`home`/`arpa`, https only, ≤ 10, shown to the admin before
  granting. Pseudonym key `DRAWBOARD_PLUGIN_PSEUDONYM_KEY` (dedicated secret).
  Export file names are sanitised by the host; extension and media type come
  from the registration. Upgrades keep only grants equal in name and value.
  Plugin storage is key-value over the protocol (≤ 200 KiB per value, 1 MB per
  plugin and board); the frame never calls `/api`.
* S4.1: ≤ 500 files per board.
* S4.4: `GET /files/{fileId}?v=<original|thumbnail|pdf>&exp=<unix>&sig=<base64url
  hmac-sha256(fileId|v|exp)>`; verification rejects `exp` in the past and more
  than the lifetime (+60 s) ahead; constant-time compare; keys ≥ 32 random
  bytes; 400 malformed, one 403 for every verification failure, 404 only after
  a valid signature; `/files/*` is the only token-less route besides the
  WebSocket and is `permitAll` for `GET` only; nginx `limit_conn` on `/files/`.
* S6.6: `/admin/*` is decided in the route table by the groups claim, not only
  in the service.

### M3 backend review: files and plugins (Fable, 2026-11-10)

Review of the M3 backend stack (`feat/m3-files` … `docs/m3-readme`: module
`files` with signed URLs, serving, Gotenberg conversion; module `plugins` with
install, grants, assets, frame document, storage) against S3.3, S3.5, S3.6,
S3.8–S3.10, S4.1–S4.5, S4.7, S4.8, S4.10, S4.11, S4.13, S1.8 (M3), S6.6,
S7.1–S7.3, S7.8 and the M3 contract review. **Verdict: approved with two MUST
fixes before files are enabled in production** (merge is fine: both need a
signed-in account; S3/S4 otherwise met, every new operation in the route table
and its test). The implementer's "not set yet" for `--pdfengines-disable-routes`
and `--webhook-disable` is outdated: both compose files set them.

| # | Level | Finding |
|---|---|---|
| 1 | MUST (before prod) | The multipart reader spools up to `max-parts` (4) × 500 MB per request to `/tmp` before the handler, the board role, the per-user limit and the 50 MB cap run; any signed-in user can fill the disk (the M1 residual (a), now ten times larger and on three routes) |
| 2 | MUST (before prod) | Thumbnailing reads the whole original (≤ 50 MB) into the heap per upload with no concurrency bound; progressive JPEGs at 50 MP cost ~300 MB native memory each in libjpeg |
| 3 | SHOULD | EXIF strip: when the segment walk does not reach SOS in the 4 MB prefix, a raw `FF DA` scan accepts the original unstripped |
| 4 | SHOULD | A full conversion queue leaves the file `PENDING` forever |
| 5 | SHOULD | Plugin storage writes (1 MiB each) have no rate limit |
| 6 | SHOULD | No startup check that the file-URL keys and the pseudonym key differ (no cross-protocol forgery is possible, hygiene only) |
| 7 | SHOULD | Quotas sum originals only; converted PDFs and thumbnails are outside them |
| 8 | SHOULD | The X-Frame-Options exemption covers all of `/plugin-assets/`, not only `__drawboard/frame.html` (non-HTML under `nosniff`, not exploitable) |
| 9 | SHOULD | Gotenberg can reach the backend's 8080/8081 over the symmetric `conversion` network; everything token-less there is harmless - document and try once |

Refinements:

* S4.1 / S2.8 / S3.9: the per-type caps hold while streaming; what Spring
  spools *before* a handler is bounded only by `max-disk-usage-per-part` ×
  `max-parts`. Rule: `max-parts: 1` (every multipart form of the contract has
  one field), and a WebFilter in front of the multipart reader on
  `POST /api/boards/*/files`, `PUT /api/boards/*/snapshot`,
  `POST /api/admin/plugins`: 411 without `Content-Length`, 413 above the route
  cap (500 MB / 51 MB / 21 MB) before the body is read, per-principal
  concurrent-upload and 30/min limits before the body; nginx
  `client_max_body_size` per route as the second cap; the spool directory on
  a size-bounded, disk-backed volume. This closes M1 residual (a).
* S4.8: the pixel cap is read from the header by a segment walk before any
  decode (met). Decoding memory is bounded by a semaphore equal to the decoder
  threads around read-plus-decode (or the image is streamed from the stored
  channel), and progressive JPEGs (SOF2/6/10/14) get a lower cap (≤ 16 MP) or
  the container memory is sized for `decodeThreads × ~300 MB` native on top of
  the heap. EXIF: "nothing to strip" is only the outcome of a walk that
  reached SOS; a failed walk never passes on a byte scan.
* S4.4: implemented as the contract review states (HMAC-SHA256 over
  `fileId|v|exp`, keys ≥ 32 bytes, first signs/all verify, every key tried in
  constant time, `exp` within lifetime + 60 s, one 403, 404 only after a valid
  signature, `permitAll` for GET only). Verified: no query string in logs
  (`url.path`, `instance` = path), in spans (test) or in audit events.
* S4.5 / S4.7 met: stored type only, `nosniff`, `default-src 'none'; sandbox`,
  CORP, `private, max-age=3600`, `attachment` except image/video, RFC 5987
  name; one validated range, 416 with `Content-Range: bytes */size`.
* S4.10 met: only `/forms/libreoffice/convert`, nothing user-controlled in the
  request, 60 s on both sides, result sniffed as `%PDF-` and capped at 50 MB,
  one worker, queue 100, 10/min per user; both compose files run Gotenberg
  8.40.0 on an `internal: true` network, non-root, read-only, with Chromium
  routes, PDF-engine routes and webhooks off and a 2 GB memory limit. A full
  queue marks the file `FAILED` (`QUEUE_FULL`) instead of leaving it pending.
* S4.11 / S4.2 met: ZIP documents are told from the central directory only
  (4 MB directory cap, ZIP64 refused); nothing is unpacked; Tika magic on the
  first 64 KB without a name; MP4/WebM refined from `ftyp`/`DocType`.
* S4.13 / S7.7 met: files and plugin storage follow the board through one
  `BoardDataEraser` (by hand, by folder, by the job); daily orphan sweep with
  a 24 h grace. Quotas SHOULD include `pdf_size`.
* S3.5 / S3.6 met: the entry list is a set of `plugin_file` rows, looked up
  by exact raw path for the current bundle of an enabled plugin; the frame
  document is generated with the entry's `integrity` (sha384) and the
  path-scoped CSP of the contract review, `no-cache`; `ACAO: *` only on bundle
  files, never with credentials; Spring's global `X-Frame-Options` is off and
  a filter re-adds `DENY` to everything outside `/plugin-assets/` (SHOULD: narrow
  the exemption to `__drawboard/frame.html`). S3.4 stays a SHOULD; without an
  own origin the bundle files are `'self'` for the app's CSP, which is the
  reason S3.4 exists.
* S3.8 / S3.9 / S6.6 met: install by admins only, decided in the route table by
  the groups claim; installed disabled with nothing granted; grants equal a
  request in name and value; upgrades keep only equal grants; pseudonym
  `HMAC-SHA256(DRAWBOARD_PLUGIN_PSEUDONYM_KEY, principalId|pluginId)` with its
  own ≥ 32-byte secret (SHOULD: fail at start if it equals a file-URL key);
  storage ≤ 1 MiB with optimistic version, read for any role, write for
  signed-in editors (SHOULD: 60/min per user and board).
* S1.8 (M3) met exactly as decided: guests read file metadata (without
  `createdBy`), URLs, the enabled list and plugin storage of their resource;
  never upload, delete, storage writes or `/admin`.
* S7.8 met: both secrets as host files via `SECRETS_DIR` (uid 10001, 0400),
  nothing secret in compose or images; dev-profile throwaway keys exist only in
  `application-dev.yaml` (profile not active in containers).

**Files in production only when:** MUST 1 and MUST 2 are fixed and tested
(an oversized `Content-Length` and a second concurrent upload are refused
before the body is read; heap stays flat under 20 parallel 50 MB image
uploads); the frontend's nginx has `client_max_body_size` per upload route,
`limit_conn` on `/files/`, no query string in the access log of `/files/`,
passes `Range`/`Content-Range`/`Accept-Ranges`, and adds neither
`X-Frame-Options` nor CSP to `/plugin-assets/`; Gotenberg has converted one
real `.docx`, `.xlsx` and `.pptx` on dev and `curl https://example.org` from
inside the gotenberg container fails; the files volume
(`/srv/drawboard/files`) is in the tested backup. **Third-party
plugins** stay off until the existing checklist above (S3.4 configured or
declined, main-app `frame-src`, Playwright negative tests, frontend M3 review)
is done; S4.12 (scanner) remains due before guests or plugins can upload.

**Status (checked in the Fable review "Publishing the source", 2026-11-12):** MUST 1 and MUST 2
are fixed and tested - `UploadGuardWebFilter` refuses an oversized `Content-Length` and a second
concurrent upload before the body is read and spools to `DRAWBOARD_UPLOAD_SPOOL_DIR`, which also
closes the M1 residual (a); `ImageWorker` bounds thumbnailing with a `Semaphore(threads)`.

### M3 frontend review: files, Mermaid, plugins (Fable, 2026-11-10)

Review of the M3 frontend stack (`feat/m3-files` … `docs/m3-readme`: uploads and
file blocks with signed URLs, pdf.js, Mermaid, sandboxed plugin host and protocol,
plugin admin page, SDK, nginx) against S3.1–S3.3, S3.5, S3.7, S3.8, S3.10, S3.11,
S4.1, S4.3, S4.4, S4.6, S4.9, S5.1–S5.3, S5.7, S6.6, S7.2, S7.5, the M3 contract and
backend reviews and the M2 frontend refinements (S5.2, S1.2). **Verdict: approved
with one MUST fix before third-party plugins are enabled in production** (merge is
fine: it needs an admin to install a plugin whose id is a prefix or extension of an
installed one). Verified in code and in a real browser (mermaid 11.17.2, stylis,
pdf.js 6.5.438 builds); every implementer claim held except where listed.

| # | Level | Finding |
|---|---|---|
| 1 | MUST (before third-party plugins) | Block ownership is a prefix test (`block.type.startsWith(id + '.')`) in `requireEdit`, `board.read` and `validatePlugin`; plugin `a.b` may write and read blocks of plugin `a.b.c` and may even declare `a.b.c.x` itself, winning the type registration and receiving the other plugin's props in `init` (S3.8); the backend's manifest check has the same gap |
| 2 | SHOULD | Message size is measured after the full `isPlainJson` walk and `JSON.stringify`; one huge message per 10 ms freezes the viewer's tab |
| 3 | SHOULD | `__proto__`/`constructor` as storage key or prop key: harmless locally, but a `storage.get` of `constructor` times out silently and `storage.set('__proto__')` loses the key |
| 4 | SHOULD | A frame can exfiltrate what its grants gave it by navigating itself (no `navigate-to` in CSP); the host stops only that frame and a re-mount starts a new one |
| 5 | SHOULD | The `url()`/`@import` strippers in `sanitizeSvg` are regexes that CSS escapes (`\75rl(`) bypass; no mermaid 11.17.2 path reaches the sheet today (verified), CSP is the backstop, but stylis lets an unbalanced `}` escape the `#id` scope - render into a shadow root |
| 6 | SHOULD | pdf.js fetches the signed URL in `cors` mode; with an own files origin (S4.6) `/files/*` needs `Access-Control-Allow-Origin: <app origin>` (never `*`) |
| 7 | SHOULD | S3.10 latency: other open boards drop a disabled plugin's frames within 60 s (poll + visibilitychange), not at once; push over the collab socket in M4 |
| 8 | Note | Licences: `robust-predicates` (Unlicense, public domain) accepted; `khroma` MIT by its licence file; the own `@apps/drawboard-api` package should name the project licence |

Refinements:

* S3.8: "own block types" means membership in the plugin's declared `blockTypes`,
  never a string prefix; two installed plugins never share a block type or an id
  that is a dot-prefix of the other (refused at install; a colliding entry in
  `listEnabledPlugins` is dropped by the host, the rest of the list still loads).
  `network` is a *connectivity* grant, not a confidentiality boundary: a frame can
  always navigate itself to a URL carrying what it knows; `board.read` and
  `block.props` are therefore the grants that decide what a plugin may leak, and the
  admin text says so. A frame that navigates itself stops the plugin on that board
  for the session, not just the one view.
* S3.7 met: one `MessageChannel` per frame, the window never listened, the port
  posted with `'*'` carrying nothing but the port; check order rate → transferred
  ports → plain JSON (prototype, finiteness, depth 64) → 256 KiB → envelope → type →
  schema → 32 pending → 10 s → 500 drops/min; the SDK accepts only the first
  `connect` from `window.parent`. Refinement: the 256 KiB bound is enforced by an
  early-exit walk before any `JSON.stringify`; `__proto__`, `constructor`,
  `prototype` are invalid keys at every depth in props and storage.
* S3.2, S3.10, S3.11 met: exactly `sandbox="allow-scripts"`, `allow=""`,
  `referrerpolicy=no-referrer`, `loading=lazy`, src `<assetBase>__drawboard/frame.html`,
  IntersectionObserver against the viewport, ≤ 50 frames, second `load` ends the
  instance, disabled plugins lose every frame when the list changes, placeholders and
  badge via `textContent`. S3.4: without a plugin origin the frames are `'self'` for
  `frame-src`; the iframe attribute and the backend's header CSP are two independent
  sandbox layers and `frame-ancestors 'none'` on every app page stops a frame
  navigating into the app.
* S4.4 (client) met: the Y.Doc and `.drawboard` hold only `fileId`; URLs come from
  `getFileUrls` (batched, in memory, renewed 5 min before expiry, dropped when
  unwatched), only `/files/<uuid>?…` is accepted and prefixed with the validated
  `filesOrigin`; URLs reach only `img.src`, `video.src`, the pdf fetch
  (`credentials:'omit'`, `no-referrer`, `redirect:'error'`) and a detached download
  anchor; never logs, errors, toasts or Faro (query stripped from URL attributes,
  free text and paths). `filesOrigin`/`pluginOrigin` are `https?://host[:port]` or the
  app refuses to start; nginx admits the same form into the CSP and `/config.json`.
* S4.1, S4.3 (client) met: uploads only for signed-in editors/owners, allowlist by
  extension, SVG refused, size caps and 30 per drop before anything is sent, names
  rendered as text; the server stays the authority.
* S4.9 met with pdf.js 6: no `eval`/`Function` in the builds (the `isEvalSupported`
  switch no longer exists), worker and assets from `/pdfjs/` on `'self'`,
  `'wasm-unsafe-eval'` only for the image decoders, `enableXfa:false`, no annotation
  layer, no scripting sandbox shipped, data passed as bytes; Playwright runs it under
  the production CSP with zero violations.
* S5.1 met: strict, `htmlLabels:false`, 50 000/500, `secure` list locks every
  HTML/CSS/sanitiser key against `%%{init}%%` and front matter, DOMPurify svg profiles
  forbid `foreignObject`/`script`/`a`/`image`, the fragment is inserted as nodes
  (no serialisation), outside `href`/`url()`/`@import` removed, ≤ 50 KB everywhere.
  Refinement: the sanitised SVG lives in a shadow root (an inline SVG `<style>` is
  then scoped), and CSS escapes are neutralised before the `url()` check.
* S7.2, S7.5, S4.5/S4.7 (nginx) met: `/files/` GET only, header allowlist, Range
  through, `limit_conn` 50/address + 400 total, access log without query or referrer,
  `error_log crit`; `/plugin-assets/` GET only; neither path gets CSP,
  X-Frame-Options or Cache-Control from nginx; body caps per upload route,
  unbuffered; CSP sources from validated env only.
* Playwright negative tests exist and pass the "Before enabling in production" list
  for plugins: no cookie/storage/parent/top navigation/popup/`/api`/foreign fetch, a
  spoofed window message and ungranted requests change nothing. Add: two plugins with
  prefix ids (MUST 1), a self-navigating frame, a 10 MB message.

**Third-party plugins in production only when:** MUST 1 is fixed on both sides and
tested (prefix ids, foreign block type refused at install and at `setPlugins`),
S3.4 is configured or declined, the main-app `frame-src` is as above, the Playwright
`sandbox` project runs in the pipeline, install/enable/disable are audit events, and
the admin text names the exfiltration residual of SHOULD 4. **Files** stay under the
backend review's list (MUST 1/2 there); when `DRAWBOARD_FILES_ORIGIN` is set, SHOULD 6
(CORS for the pdf fetch) goes to the backend first.

### M4 contract review: planning poker (Fable, 2026-11-10)

Review of the M4 contract (api `feat/planning-poker`, f1d97c8) against 3.10,
S7.6, S1.7, S1.8, S1.10, S6.9, S7.1, S7.3. **Verdict: publish as 1.4.0 after
three changes** (participant cap with `PLANNING_ROUND_FULL`; the guest rule
below written into the contract; guests join on vote only, never on GET).
Decisions:

* S7.6 (refined): rounds, participants and votes live only on the server; the
  server never reads or writes the Yjs document. "The reveal writes the
  result" means: after `revealPokerRound` the revealing client (facilitator or
  owner) writes `estimate` into the story card and clears `pokerRoundId` as an
  ordinary editor update; any editor may do it later from the revealed round.
  `storyBlockId` and `pokerRoundId` are untrusted hints: the server checks only
  the id format and that the round belongs to the board in the path; a client
  binds the dialog to a card only when `round.storyBlockId` equals the block
  id. Facilitator = the creating EDITOR/OWNER; reveal and cancel by the
  facilitator while still EDITOR/OWNER or by the board's OWNER, both final.
  No value is visible before the reveal - not to the facilitator, not in
  audit or logs; `PLANNING_VALUE_INVALID` never echoes the value. Cap 200
  participants per round: `castPokerVote` → 409 `PLANNING_ROUND_FULL`,
  `getPokerRound` never fails from the cap. `version` rises on join, first
  vote, reveal and cancel; a changed vote SHOULD not raise it. Answers of
  `getPokerRound` carry `Cache-Control: no-store` and SHOULD `Vary:
  Authorization`; `If-None-Match: *` is no match. Deck values and title
  reject Cc/Cf code points, distinct after NFC (SHOULD). Closed rounds per
  board bounded (SHOULD ≤ 500, oldest CANCELLED then REVEALED pruned). Audit:
  round created/revealed/cancelled with board, round, story block, actor and
  vote count (members and guests separately), never a vote or a join;
  rate-limit and cap refusals are metrics. Rounds follow the board into the
  trash and are hard-deleted with it; cancel deletes votes at once; a deleted
  user's participant rows read "Deleted user" (SHOULD).
* S1.8 (M4): guests whose link role is COMMENTER or EDITOR may call
  `listPokerRounds`, `getPokerRound` and `castPokerVote`, only for the board
  of their link or boards below their folder (S1.7): `listPokerRounds` only
  with `state=OPEN` (other states 403); `getPokerRound` on OPEN rounds
  always, on REVEALED or CANCELLED rounds only when the guest session is a
  participant (else 404 `PLANNING_ROUND_NOT_FOUND`) - a guest never gets a
  board's estimation history, which would be a list of every member who ever
  voted (S1.10, S6.9); `facilitatorId` absent; guests are never added by
  `getPokerRound`, only by `castPokerVote`; at most 20 guest participants per
  link and round and 50 per round (409 `PLANNING_ROUND_FULL`); guest
  participant identity is the guest session's `sub` (stable across refresh,
  ≤ 12 h; a re-exchange is a new participant, visible by `guest: true`);
  revoking the link removes its guest participants and votes from OPEN
  rounds at once (S1.13); guest poker limits are keyed by share as well as
  session (SHOULD ≤ 300 get, ≤ 100 vote per share, round and minute).
  VIEWER-link guests: 403 on every poker operation. `createPokerRound`,
  `revealPokerRound`, `cancelPokerRound`: never guests.
* S1.10: participant and result names are the display name (or guest name,
  `guest: true`) as stored at join time, never user ids. Members keep seeing
  names of participants who later left the board (the round is a record);
  guests see them only in rounds they take part in.
* S7.3: list 30/min per user and board, create 10/min per user, vote 30/min
  per user and round, get 60/min per user and round (304 counts); 429 with
  `Retry-After`; clients back off on 429. Reveal and cancel need no limit.

### M4 backend review: planning, metrics, scanner (Fable, 2026-11-10)

Review of the M4 backend stack (`feat/m4-planning` 7597167 … `docs/m4-readme`
a7ba88a on `fix/m3-security-review` 0dba85b: module `planning` with rounds,
participants, votes, guests and revocation; usage metrics and dashboard
"17 · Drawboard usage"; `FileScanner` port with the ClamAV `zINSTREAM`
adapter) against S7.6, S1.7, S1.8 (M4), S1.10, S6.9, S7.1, S7.3, S7.10,
S4.12 and the M4 contract review. **Verdict: approved; merge as is.** Every
rule of the contract review is implemented and tested (authorisation order,
IDOR, guest scope through folder links, closed-round visibility, vote secrecy
in list/get/304/audit/logs/metrics, caps, share-keyed limits, pruning, trash
and purge, revocation). Two deployment MUSTs apply before the scanner carries
weight in production (below).

| # | Level | Finding |
|---|---|---|
| 1 | SHOULD | Fail-closed refuses every file over `clamav-max-bytes` (25 MiB) with a 500: no video can be uploaded; answer 413 for `TOO_LARGE`, align clamd `StreamMaxLength` with `max-video-bytes`, warn at start when the two disagree |
| 2 | SHOULD | "Could not be scanned" is a 500 with a stack trace per upload; 503 with `Retry-After` (or 500 at WARN) |
| 3 | SHOULD | A blob that cannot be opened skips the scan silently, also under fail-closed; treat it as `Unavailable` |
| 4 | SHOULD | The dashboard has no `drawboard_scans_total` panel; without it a fail-open deployment with clamd down looks healthy. Panel plus alert on `result="unavailable"` |
| 5 | SHOULD | `removeGuestsOfShare` runs after the revoke commit without a safety net; log instead of failing the revoke, and drop revoked shares' participants at reveal |
| 6 | SHOULD | `listPokerRounds` loads up to 50 × 200 participant rows per call; load only the visible rounds, consider a smaller list cap for `OPEN` |
| 7 | SHOULD | Caps hold per replica (`KeyedLocks`); the DB unique keys back the two integrity invariants; `FOR UPDATE` on the round row before a second replica |
| 8 | SHOULD | `FileAuditDetails` header says "never a signature" while `FileRejected.signature` is the scanner's finding; reword |

Refinements:

* S7.6 met as refined: rounds, participants and votes live only in schema
  `planning`; the server never reads or writes the Yjs document;
  `storyBlockId` and `pokerRoundId` are format-checked hints. Facilitator =
  creating EDITOR/OWNER; reveal and cancel by the facilitator while still
  EDITOR/OWNER or by the OWNER; 404 before 403 for the round. No value leaves
  the server before the reveal: `voted` only, `myVote` for the matching
  principal, no vote in audit (counts of members and guests), logs (no logger
  in the module, span attributes are ids only) or metrics; cancel deletes
  votes before the state change; a changed vote does not raise `version`.
* S1.8 (M4) met: `signedInOrGuest` only on list, get, vote; the service turns
  VIEWER-link guests away (403), lists OPEN only, shows closed rounds only to
  participants (404 before the ETag check), omits `facilitatorId`, never
  joins a guest on GET; caps 200/50/20 with `PLANNING_ROUND_FULL`; limits
  per session and per share; revocation removes a link's guests from OPEN
  rounds and raises the version. Guest identity is the session `sub`; a
  guest whose link expires or is downgraded keeps a vote cast while allowed
  (the record stands; the token dies within ≤ 30 s).
* S7.3 met: 10 creates/min per user, 30 lists per user and board, 60 gets
  (304 counts) and 30 votes per user and round, 300/100/300 per share;
  refusals are metrics (`drawboard.planning.refused{reason}`), never audit;
  limiter keys bounded (M2).
* S7.7 / pruning: ≤ 500 closed rounds per board, oldest CANCELLED then
  REVEALED, participants deleted before rounds with a FK behind it; rounds
  follow the board into the trash (404) and are purged through
  `BoardDataEraser`.
* S7.10 met: every metric label is a fixed set (`event`, `reason`, `result`,
  `window`, `kind`, `audience`); gauges are read every five minutes, never
  on scrape; the dashboard holds no secret and uses datasource uid
  `prometheus` like the others.
* S4.12 implemented as a port with a no-op default and an optional clamd
  INSTREAM adapter: scan before any parser and before the metadata row,
  infected → 415 without the signature, `files.file.rejected` with signature
  (printable, cut) and SHA-256, bytes removed; size checked before and during
  the stream; connect timeout, socket timeout and a watchdog; error texts
  never kept; converted PDFs are not rescanned (accepted: made by Gotenberg
  from the scanned original, viewed with scripting off). Fail-open is the
  default and acceptable while only signed-in editors upload (S1.9, S3.8).

**Planning poker with guests in production only when:** `DRAWBOARD_GUESTS_ENABLED`
checklist of the M2 review is done (trusted proxies verified, signing key as a
file secret), the frontend M4 review has passed (poll with `If-None-Match`,
back-off on 429, estimate written into the card only by the revealing client
and only when `round.storyBlockId` matches), and one revoke on dev has been
seen to remove the link's guests from an OPEN round.

**Scanner in production only when:** clamd runs on an `internal: true`
network reachable only from the backend (no host port, like Gotenberg), the
EICAR test file is refused with 415 on dev and appears as
`files.file.rejected` in the audit trail, `drawboard_scans_total` is on the
dashboard with an alert on `result="unavailable"` (SHOULD 4), and - **MUST
once guests or third-party plugins may upload** - `DRAWBOARD_CLAMAV_FAIL_CLOSED=true`
with `DRAWBOARD_CLAMAV_MAX_BYTES` and clamd's `StreamMaxLength` set to at
least `files.max-video-bytes` (SHOULD 1), otherwise fail-closed makes videos
impossible and fail-open means no scanner.

### M4 frontend review: kanban, story cards, poker (Fable, 2026-11-10)

Review of the M4 frontend stack (`feat/m4-kanban` … `docs/m4-readme` on
`docs/m3-readme`: `core.kanban` with `BlockHost`, `BlockRequest`, input and
`cloneProps` changes, `core.story`, the planning poker client, Playwright
guest-allowlist and restless-plugin tests, the nginx header check) against
S7.6, S1.8 (M4), S1.10, S5.2, S5.5, S3.1/S3.8, S3.12, S7.5, the M4 contract and
backend reviews and the M2/M3 frontend refinements. **Verdict: approved; merge
as is.** Every implementer claim held in code; the 183 unit tests of the new
specs and `check:headers` pass. Six SHOULDs, no MUST.

| # | Level | Finding |
|---|---|---|
| 1 | SHOULD | `Renderer` hands `BlockHost` to the render context of *every* block type; plugin types ignore it by convention (`PluginBlockView` takes `ctx.block` only), not by rule. Gate it on `BlockType.trusted`, set only in `registerBuiltinBlocks`, with a test that a plugin type sees `ctx.host === undefined` |
| 2 | SHOULD | `check-headers.mjs` turns unknown CSP directives into notes and does not ban `'unsafe-inline'`/`'unsafe-hashes'`/`data:`/`blob:` in script-ish directives (`script-src-elem 'unsafe-inline'` passes); only the `default` map entry is checked. Unknown directives are errors, rules for `script-src-elem`/`-attr`/`child-src`, every map entry checked, three more mutations in the spec |
| 3 | SHOULD | The poker dialog binds to the card's own `pokerRoundId` before the server's pairing: a hostile editor pointing card A at another round hides A's real round in the dialog, and each flip costs one unthrottled `getPokerRound`; a mismatch calls `stop()` on a shared lease. Prefer `openRoundOf(blockId)`, debounce candidate changes, release instead of stop |
| 4 | SHOULD | `form-action 'self' $oidc_origin`: no form is ever posted to the provider (`location.assign`, `fetch`, iframe). Back to `'self'` as S7.5 says |
| 5 | SHOULD | S3.12 Trusted Types not enabled: pdf.js `workerSrc` and Mermaid's `<style>.innerHTML` are the two sinks. Enable enforced with the policy below, proven in the Playwright `sandbox` project first |
| 6 | SHOULD | `location /` serves the SPA shell for `/.env` and friends (200). `location ~ /[^/]*\.[^/]*$ { try_files $uri =404; }`; deployment SHOULD restated |

Decisions and refinements:

* S1.10 / kanban assignee: stored as the **display name only** (≤ 64 chars,
  the S1.3/S2.6 name cap), never a user id - the document and the `.drawboard`
  file are readable by every link guest and leave the instance; an id in them
  would be a member directory (the contract hides `facilitatorId` from guests
  for the same reason). The picker reads `listBoardMembers` for signed-in
  users only; guests see the name as text. Rename drift accepted. A stable
  reference, if ever needed, is a per-board pseudonym and a new review.
* S7.5 refined: `frame-src 'self' <oidc-origin> <plugin-origin>
  <embed-allowlist>` - the silent sign-in iframe loads the provider's
  authorization endpoint and returns to `/silent-renew.html` (own CSP,
  `frame-ancestors 'self'`); `<oidc-origin>` is scheme+host(+port) cut from
  `OIDC_ISSUER`. `form-action` stays `'self'` (SHOULD 4).
* S3.12 decided: enforced Trusted Types in the main app, CSP
  `require-trusted-types-for 'script'; trusted-types angular dompurify
  drawboard default` (no `'allow-duplicates'`, no `angular#unsafe-bypass`).
  Policy `default`: `createHTML` returns the string only while a Mermaid render
  is running, for the `Element innerHTML` sink and only when it contains no
  `<`; `createScript`/`createScriptURL` throw. Policy `drawboard`:
  `createScriptURL` accepts exactly `<self>/pdfjs/pdf.worker.min.mjs` without
  query or hash; pdf.js gets it as `GlobalWorkerOptions.workerPort`. Order: the
  Playwright `sandbox` project runs under the enforced header with zero
  `securitypolicyviolation` events (Mermaid incl. `%%{init}%%`, PDF with
  worker, plugin block, kanban, story) → dev → prod. A
  `securitypolicyviolation` listener reports directive, disposition and the
  origin of `blockedURI` (never `sample`) to Faro. Due before third-party
  plugins are enabled in production.
* S3.1/S3.8 (BlockHost): no path hands `BlockHost`, the `BoardDoc` or anything
  reachable from them to a frame, a port or a message handler (verified in
  `plugin-host.ts`, `plugin-instance.ts`); `blockRequested` carries
  `action`/`itemId` only and the page resolves them through the models.
  Refinement: `host` reaches a view only for `trusted` types (SHOULD 1).
* S5.2, S5.5 met: every style value from props is a palette key resolved
  through `safeColor`, every text is `textContent`/`renderSafeText`; kanban and
  story import validated field by field (UUIDs, `hasOwn` labels, existing
  column, real dates, bounded numbers, unique ids), `pokerRoundId` never in a
  file, `cloneProps` with `defineProperty`.
* S7.6 and the M4 contract duties met: `If-None-Match` and 304 handling, one
  poller per round per tab, no overlapping polls, pause while hidden, 429
  `Retry-After` (≤ 5 min) else exponential to 30 s, stop on 401/403/404, own
  vote kept from the 204, binding only on `round.storyBlockId`, estimate
  written only from the `revealed` view by a non-read-only client while the
  card still points at the round (compare-and-set), votes never in the Y.Doc,
  no vote in spans, toasts or Faro.
* S1.8 (M4) met: `access` is `vote` for COMMENTER/EDITOR links and `none` for
  VIEWER links; `none` makes no poker call at all; guests are never offered
  start, reveal or cancel; `e2e/guests/guest-allowlist.spec.ts` proves the
  guest UI calls only allowlisted operations.

**Planning poker with guests in production only when:** the `DRAWBOARD_GUESTS_ENABLED`
checklist of the M2 review is done (trusted proxies verified, signing key as a
file secret), this review's SHOULD 3 is fixed (binding prefers the server's
pairing), the Playwright `mocked` project (guest allowlist) and `sandbox`
project run in the pipeline, `package.json` names the released contract 1.4.0
(today 1.2.0 with a local build), and one revoke on dev has been seen to remove
the link's guests from an OPEN round. The frontend M4 review required by the
backend review has passed with this entry.

### Authelia consent and refresh tokens (Fable, 2026-11-10)

Authelia asked for consent on every login: it forces explicit consent whenever
`offline_access` is requested, whatever `consent_mode` says (Authelia FAQ;
PR #9331). The SPA never needed `offline_access` - the user is present, and
`signinSilent()` renews through the `/silent-renew.html` iframe (`prompt=none`)
when there is no refresh token. **Decision: drop `offline_access` and the
`refresh_token` grant; renew against the Authelia session; `consent_mode:
'pre-configured'`, `pre_configured_consent_duration: '1y'`.** Rationale: the
browser then holds no credential that outlives the provider session; logout,
`two_factor`, `inactivity` and `remember_me` apply immediately; XSS exposure is
unchanged (tokens stay in memory, nothing persistent). `sso.dergeorg.at` and
the app origins are same-site (`dergeorg.at`), so the `Lax` session cookie
reaches the iframe and third-party-cookie blocking is not a factor. `implicit`
is discouraged by Authelia and non-standard; `explicit` asks every time;
`pre-configured` re-asks only when the scope set changes.

**S6.1 now reads:** MUST Frontend: code + PKCE (S256), no implicit/hybrid,
exact redirect and post-logout URIs, tokens in memory only. Renewal by silent
sign-in (`prompt=none`) in a hidden iframe against the provider session; **no
`offline_access`, no refresh tokens** while provider and app are same-site. A
cross-site provider would need refresh tokens with rotation enabled at the
provider - and a new review. Logout MUST end the provider session (RP-initiated
logout, or the provider's own logout endpoint when discovery has no
`end_session_endpoint`); a logout after which a reload silently signs in again
is a defect.

MUST (frontend first, then Authelia):

1. `OIDC_SCOPE: openid profile email groups` in `compose.dev.yaml` and
   `compose.prod.yaml`.
2. Client `drawboard`: `scopes: ['openid', 'profile', 'email', 'groups']`,
   `grant_types: ['authorization_code']`, `consent_mode: 'pre-configured'`,
   `pre_configured_consent_duration: '1y'` (script 25; header comment too).
3. Logout: `sso.dergeorg.at` has no `end_session_endpoint` (discovery checked
   2026-11-10), so `signoutRedirect()` fails, the fallback reloads and
   `start()` signs the user in again. `OidcAuth.logout()` navigates to
   `<issuer>/logout?rd=<origin>/` when the metadata has no end-session
   endpoint; `signoutRedirect()` stays for providers that have one.
4. Silent-renew failure (`login_required`, `interaction_required`,
   `consent_required`, timeout) = session over: drop the in-memory user, the
   next 401 triggers `login(returnUrl)`; no redirect from `token()`, no retry
   loop (as implemented).

SHOULD: `lifespans.custom.drawboard` with `access_token: '15m'`,
`id_token: '15m'` and `lifespan: 'drawboard'` on the client, with
`session.inactivity` above that (check the server config; default `5m` would
end the session between two hourly renewals); Authelia CORS `endpoints:
['token']` only; the deployment-review item "verify refresh-token rotation" is
void. CSP unchanged: `frame-src 'self' <oidc-origin>` (M4) and `connect-src
<oidc-issuer>` already cover the iframe and the code exchange.

### Plugin origin (S3.4) configured (Fable, 2026-11-10)

Review of frontend!41 (nginx maps `$plugin_authority`, `$host_role`,
`$deny_request`, `$header_uri`, server-level `if … return 404`,
`check-headers.mjs`, `e2e/headers`, compose `PLUGIN_ORIGIN`) and backend!32
(`DRAWBOARD_PLUGIN_ORIGIN` in both compose files). The plugin origin
`https://draw-plugins.dergeorg.at` (dev `drawboard-plugins-dev.dergeorg.at`) is the
frontend nginx container under a second host name; NPM routes both names to port
18090 and nginx tells them apart by `Host`. **Verdict: approved, merge both.**
No MUST, four SHOULDs.

* S3.4 met, three independent lines: the app host answers 404 for
  `/plugin-assets(/|$)` before any location is chosen (normalised `$uri`, so
  `//`, `/../`, `%70` and `/Plugin-Assets` are all refused); the frontend's
  `validatePlugin` drops every plugin whose `assetBase` is not on the plugin
  origin; the backend hands out `assetBase` on `DRAWBOARD_PLUGIN_ORIGIN`. No
  plugin file is a `'self'` script of the app any more.
* The plugin host serves `GET /plugin-assets/*` and nothing else (shell,
  `/config.json`, `/api`, `/files`, `/faro`, `/healthz` → 404 with the app's
  full header set). Nothing there carries credentials (S7.4), the backend
  ignores `X-Forwarded-Host`, the frame document's header CSP `sandbox
  allow-scripts` gives it an opaque origin even when opened top-level, bundles
  never contain `.html`/`.svg`. Not a second app origin.
* Frame CSP and app CSP line up (`script-src <plugin-origin>/plugin-assets/…`,
  `frame-ancestors <DRAWBOARD_PUBLIC_URL>` from the backend; `frame-src 'self'
  <oidc-origin> <plugin-origin>` from nginx; identical values in both compose
  pairs; a differently spelled pair fails closed).
* Host tricks examined: NPM is the only client and forwards `Host $host`, rejects
  duplicate `Host` and never routes an unknown host to a proxy host, so the
  container's `$http_host` is NPM's routing decision. Binding deployment
  conditions: the plugin proxy host passes Host unchanged, has no access list or
  forward-auth, and targets the frontend container, never the backend.

| # | Level | Finding |
|---|---|---|
| 1 | SHOULD | A non-empty but invalid `PLUGIN_ORIGIN` silently falls back to `legacy` while the backend still points frames at the plugin origin: fail at container start or deny everything |
| 2 | SHOULD | `check:headers` and the Playwright `headers` project in the pipeline (`sandbox` project of the e2e job, frontend!38, covers `e2e/headers`) |
| 3 | SHOULD | Host map: restrict the backreference to `[A-Za-z0-9.:-]+` so a Host containing `\|` can never match |
| 4 | SHOULD | README names the three NPM conditions above |

**Third-party plugins in production only when** (updated): ~~MUST 1 prefix ids~~
fixed on both sides; ~~S3.4 configured or declined~~ configured (this entry);
~~main-app `frame-src`~~ as above; ~~install/enable/disable audit events~~
present; ~~admin text names the exfiltration residual~~ present. Still open: the
Playwright `sandbox` and `headers` projects run in the pipeline (frontend!38);
Trusted Types enforcement live; one verification through NPM on dev (plugin host
`/` and `/config.json` → 404 with app headers, a frame document → 200 with the
sandbox CSP, app host `/plugin-assets/x` → 404, a plugin block renders).

### Quick poker rounds (Fable, 2026-11-10)

Review of quick planning poker rounds without a story card (contract 2.0.0,
backend and frontend `feat/quick-poker`) against S7.6, S1.8 (M4), S2.6, S7.3 and
the three M4 reviews. **Verdict: approved; merge as is.** No MUST. A quick round
is a round whose `storyBlockId` is absent: it binds to no card, its result is only
shown and written nowhere.

| # | Level | Finding |
|---|---|---|
| 1 | SHOULD | `PlanningIntegrationTest` QuickRounds reveal test was red once (vote order) and green on the gate; compare as a set or fix the `position` race |
| 2 | SHOULD | `BoardPokerDialog.blockId` is optional now; make the mode explicit so a card dialog without a block id fails instead of becoming a quick dialog |
| 3 | SHOULD | `package.json` names `^1.4.0` while the code needs 2.0.0; released 2.0.0 before production |

Decisions and refinements:

* S7.6 kept: votes, participants and results stay on the server; quick mode has no
  `StoryModel`, every document write is behind `model?.`. Binding rule both ways:
  a card dialog shows a round only when `round.storyBlockId` equals its block id,
  a quick dialog only when the server says the round has no card.
* S1.8 (M4) kept: create, reveal, cancel stay signed-in EDITOR/OWNER; guests on
  COMMENTER/EDITOR links list, get and vote in quick rounds; VIEWER-link guests
  403 and see no pill.
* S7.3 / caps kept: the 10/min create limit runs first; the cap of 10 OPEN rounds
  per board counts both kinds; "one OPEN round per card" only with a card
  (partial unique index, NULLs distinct).
* Discovery of quick rounds: **(a) the pill re-lists on open, throttled 5 s,
  server 30/min** - decided. **(b) awareness** allowed later only as a "poke":
  payload field `poker: <counter>` and nothing else, raised on
  create/reveal/cancel; receivers with access call `loadOpenRounds()` only, never
  `getPokerRound` of anything from the frame, render nothing from it, use `from`
  for no authorisation; any id in the payload is a new review. **(c) a board-level
  `openQuickRounds` list in the Y.Doc is rejected**: persistent, exported,
  versioned, editor-writable and unbounded.
* Contract: `response-property-became-optional` is a real behaviour change for
  typed clients and a compile break for Kotlin consumers; `feat!` and 2.0.0 are
  right, no `oasdiff-ignore.txt` entry.

**Quick rounds in production only when:** backend and frontend name the released
contract 2.0.0, the planning integration tests ran green in the pipeline, and the
M4 conditions still hold.

### Clipboard, frames, tables (Fable, 2026-11-11)

Review of frontend `feat/clipboard`, `feat/frames` and `feat/table` against S2.4,
S2.5, S2.7, S3.1, S3.2, S3.7, S3.8, S4.1, S4.4, S5.2, S5.3, S5.5, S7.6 and the
M2–M4 frontend reviews. **Verdict: merge after MUST 1**; SHOULDs 2–5 before
production, 6 optional. The clipboard is untrusted input and goes through the
import validators; frames and tables degrade deterministically on every client.

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | MUST | Clipboard limit 5 MiB but one paste is one Yjs transaction; an UPDATE above the protocol's 1 MiB (S2.5) makes the provider drop its pending queue and demand a reload - one Ctrl+V from a hostile page loses the user's unsent edits | `CLIPBOARD_LIMITS.maxBytes = 512 KiB` (copy and paste) plus a test that every update of a maximal paste is < 1 MiB; or write in pieces like the importer |
| 2 | SHOULD | `assignParents` recomputes `blockShapes()` per block; `descendants` uses `shift()` | Frame list once per call, index walk |
| 3 | SHOULD | Plugin protocol doc does not say that block props are written by others | Sentence under `block.props`/`block.changed`: validate props like any input |
| 4 | SHOULD | Plugin blocks accept `text` on paste although they have no Y.Text | `text` only for built-in types |
| 5 | SHOULD | `isEditableTarget` misses `contenteditable="plaintext-only"` | Add it |
| 6 | SHOULD (optional) | Frame delete removes descendants silently | A toast "N items deleted - Ctrl+Z" above ~10 descendants; no confirmation |

Decisions:

* **Clipboard (S5.5 extended):** `application/x-drawboard+json` envelope
  `{drawboard, version, sourceBoard, content}`; size checked before
  `JSON.parse`; ≤ 2000 blocks/connectors/strokes; the `.drawboard` import
  validators with `Object.hasOwn`, parent links validated, tables normalised;
  new ids; `pokerRoundId` never travels. `text/plain` → one sticky; HTML is never
  read. Cut and paste only for editors (the server's S2.4 is the control). Any web
  page can plant the MIME type: accepted, because paste is a visible, selected,
  undoable user action meeting exactly the import rules; `sourceBoard` is a
  convenience, not a control.
* **Plugin blocks may be pasted** when the plugin is enabled on the target board
  and the type is one of its declared, non-trusted types; props pass
  `withinBound` → `isPlainJson` → ≤ 64 KiB and are stored as a `structuredClone`;
  never `core.*` through that path; pasted blocks get no `BlockHost`. Props were
  never a trust boundary of the plugin; the paste applies the same checks as
  `block.setProps`. `.drawboard` import keeps refusing plugin types (new board,
  nothing enabled - the same rule with zero types).
* **Frames:** `core.frame` via `parent`; membership = innermost frame under the
  centre; depth ≤ 8 on write and on read (dangling, non-frame, cyclic and
  too-deep links resolve to top-level), so a hostile peer's parent graph cannot
  loop any client. Delete takes descendants, one undo step, no confirmation.
* **Tables:** a frame with `props.table` and cell frames with `props.cell`;
  ≤ 50 × 20 cells; whatever is not an intact grid is plain frames; lone cells are
  never deleted.
* **Guests (EDITOR link)** gain nothing beyond what Yjs update rights already
  allowed; S2.4, S2.5, S2.7, S1.9 and S4.1 hold unchanged.

### Zoom-out, follow and summon (Fable, 2026-11-11)

Review of frontend `feat/zoom-out` (e276400) and `feat/follow` (fbb66ce) against
S1.8, S1.10, S2.4–S2.6, S3.2, S5.2, the awareness "poke" rule of the quick poker
review and the M2–M4 frontend reviews. **Verdict: zoom-out approved as is;
follow approved for merge, MUST 1 before `deploy:prod`** (prod has guests on).
The awareness payload gains `viewport {x, y, zoom}`, `following` (client id) and
`summon {id, targets}`; `parsePeerState` validates every field on its own
(own properties, finite numbers, |x|,|y| ≤ 1e7, zoom 0.02–8, uint32 ids, 1–50
targets or `"all"`, selection ≤ 100 × 64 chars, a bad field = absent, frames above
16 KiB not parsed); no free text, names only from `From`. The glide converges in
finite time and cannot reach NaN.

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | MUST | Summon authority decided from the member list: guest receivers accept any signed-in sender, signed-in receivers accept unresolved senders when an EDITOR group grant exists, every receiver polls `listBoardMembers` | Server puts `role` into `From` (`PeerJson.from`, rebuilt in `applyRole`, documented in `collab-protocol.md`); receivers honour a summon only if `from.guest === false` and `from.role ∈ {OWNER, EDITOR}`, absent role = refusal; member-list path removed |
| 2 | SHOULD | `FollowController.decided` unbounded (30 new ids/s per hostile peer) | One entry per sender, or cap 1000 |
| 3 | SHOULD | A presenter may re-summon every 15 s with a new id | After two stops of the same sender within 2 min, auto-ignore for the session with a toast |
| 4 | SHOULD | Following someone who follows me makes both cameras drift | Refuse `follow()` when the peer follows me |
| 5 | SHOULD (optional) | `canPresent` follows the metadata reload, not the `ROLE` frame | End presenting on the provider's role change too |

Decisions:

* **Summon authority (S2.6 extended):** the server marks the sender's board role in
  `From` (`role`, from the session's re-evaluated role); the receiver decides, with
  exactly one rule: `from.guest === false` and `from.role` OWNER or EDITOR, else no;
  same for guests and signed-in receivers; no member list is read for it. Each
  (sender `From.id`, summon id) is decided once, stopping is final for that summon,
  one honoured summon per sender per 15 s, "ignore" per `From.id` for the session, any
  own navigation or Esc stops, a presenter leaving or losing the role stops with a
  notice. The sender UI offers summoning only to signed-in OWNER/EDITOR; that is
  convenience, the receiver rule is the control.
* **Viewport privacy (S2.4):** every participant's viewport goes to every participant,
  guests included: same visibility class as the cursor and coarser than it, rounded to
  whole world units and 4 zoom decimals, bounded, ≤ 10/s with the other awareness.
  Not limited to "while followed" (an opt-in over awareness leaks the same and blocks
  Follow). Never rendered as a "who looks where" list or minimap without a new review.
* **Follower list and presenter name:** `following` is display-only (a spoofed value
  adds a server-named person to "n following" and nothing else); "X is presenting"
  renders `From.name` only.
* **Zoom-out (S5.2, S3.2 kept):** below 15 % every block is a plain box; the colour
  comes from trusted types only and always through `safeColor`, plugin and file
  types get the neutral grey; titles via `textContent`; plugin iframes are unmounted
  far out and remounted through the normal mount path. The e2e socket stand-in is
  Playwright-only and not in the build.

### Publishing the source (Fable, 2026-11-12)

Review of the four repositories (api, backend, frontend, deploy; every ref and the full
history of each) before the source goes public on GitHub as one repository under AGPL-3.0.
**Verdict: publish after three MUSTs**, none of them a code change.

* **Secrets:** none, ever. The nine gitleaks findings in the backend history are the
  throwaway values of the dev profile and the integration tests (base64 of
  `dev-only-…`/`integration-test-…`), the PEM regex in `GuestKeys`, a key generated per
  test run, the fixed `Sec-WebSocket-Key` of two tests and the local Grafana `admin/admin`.
  Production values (`DB_PASSWORD`, `file_url_keys`, `plugin_pseudonym_key`,
  `guest_signing_keys`) are referenced from the stack environment and `SECRETS_DIR` only and
  never appear in any history. Nothing to rotate.
* **Infrastructure details** (LAN addresses, subnets, data paths, Portainer ids, public host
  names) may be published; they grant nothing. Scrubbing them from the public copy and
  dropping the `CLAUDE.md` working notes is a SHOULD, not a control.
* **History:** the public repository is built from snapshots of `main` and the release
  tags (not a mirror of all refs); a full history would also have been acceptable, no
  filtering is required for security.
* **Section 8 stays public in full**, open items included. Every "before production" MUST
  is implemented in the released code (M1 (a) via the upload spool, M3 backend MUST 1/2
  via `UploadGuardWebFilter` and the `ImageWorker` semaphore, prefix ids, follow MUST 1,
  contract 2.0.0); what remains open is SHOULD-level (JWKS kid-miss rate limit, one
  audience per environment, outbound byte-bound exactness). Known weaknesses are fixed,
  not hidden.
* **Code and defaults:** no default secret works outside the dev profile, Swagger and the
  actuator are off or unexposed, `permitAll` routes are signature- or ticket-checked,
  trusted proxies default to none, the chart refuses to render without a key Secret.

MUST before the first push: (1) `LICENSE` (AGPL-3.0) at the root, and the publish branches
must name the same licence instead of `LicenseRef-Drawboard-Terms`; (2) the chart README
states the operator conditions for `guests.enabled` directly (trusted proxies set and
verified through the `ip` of `library.share.exchange-failed`, signing key as a Secret file,
TLS and `Referrer-Policy`/CSP verified through the ingress, tested backups, EDITOR-link
guests edit content, third-party plugins only with a separate plugin origin); (3) the sync
job takes the GitLab `main` trees only and runs gitleaks over the assembled tree on every
run, refusing to push on a finding.

SHOULD, now that the code is public: rate-limit the JWKS refetch on unknown `kid`
(deployment review 2026-11-09); refuse `APP_ENVIRONMENT=prod` with the `dev` profile (its
keys are public); record the M3 backend MUST 1/2 as closed above; fix the stale subnet and
guest lines in the backend README.

**Done (2026-11-12):** (1) `LICENSE` in the deploy repo, copied to the root of the public
tree; chart and image labels say `AGPL-3.0-only`. (2) Chart README, "Before enabling guest
links". (3) `deploy/scripts/github-sync.sh` (job `sync:github`): `git archive` of `main`
only, agent notes dropped, LAN addresses and data paths outside `src/` replaced by
documentation values, `gitleaks dir` with `public/gitleaks.toml` (default rules plus the
reviewed findings by exact value or rule and file) - any finding stops the run before the
push. The M3 status is recorded above.

### Before enabling in production

**Guests (`DRAWBOARD_GUESTS_ENABLED=true`) only when** S1.1–S1.14, S2.1–S2.8,
S4.4/S4.5, S5.7, S6.9 and S7.1–S7.3 are implemented and tested (exchange,
refresh, revocation closes sockets, password limits, identical 404s), and
`Referrer-Policy: no-referrer` is verified.

**Third-party plugins only when** S3.1–S3.3 and S3.5–S3.10 are implemented,
S3.4 is configured or deliberately declined, the main-app CSP is active with
`frame-src` limited to the plugin origin and embed allowlist, a sample plugin
provably can **not** read `parent`, `fetch` `/api`, navigate the top window,
open a popup or write props of foreign block types (Playwright negative tests
in the pipeline), and install/disable show up as audit events.

### Phase mapping of the MUSTs

| Phase | MUSTs |
|---|---|
| M0 | S6.1, S6.2, S6.4, S6.6, S6.7; S7.2, S7.4, S7.5, S7.8; route table with `denyAll`; secrets; `X-Forwarded-For` only from the proxy |
| M1 | S2.1–S2.10; S5.2, S5.3, S5.7; S7.1 (base events), S7.3 (tickets, WebSocket) |
| M2 | S1.1–S1.14; S6.5, S6.9; S5.5, S5.6; S7.3 (exchange, password, search), S7.7, S7.9; version restore in the UI |
| M3 | S3.1–S3.3, S3.5–S3.10; S4.1–S4.5, S4.7–S4.11, S4.13; S5.1, S5.4; S7.1 (plugin/file events), S7.3 (uploads, conversion, install) |
| M4 | S7.6 and S1.8 (M4) as refined in the M4 contract review; S3.12 and S4.12 (SHOULD); final hardening: Playwright negative tests for sandbox and guest allowlist, header check against this list |
