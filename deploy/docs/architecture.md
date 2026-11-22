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
  frontend/   Angular app; src/board-engine is the view side of the engine (renderers, tools,
              input, text editor, plugin host), src/plugin-sdk the SDK for plugin authors
  engine/     npm package @apps/drawboard-engine: the DOM-free engine core (board model, file
              format, templates, collaboration protocol and provider); runs in the browser and
              in Node, used by the frontend and later the MCP server and the desktop app
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
  editing. `template` grants nothing: reading, copying, editing, sharing and trashing follow
  the board's roles. Only the owner switches the flag; every change is an audit event.
* `listTemplates` lists every template the caller may open (own, shared directly, by group,
  by link, inherited from a folder). Its candidates come from the caller's grants (own,
  direct, group, link, folder subtree), at most 1 000 per call and 30 calls per minute,
  never from all templates of the instance (Fable T4).
* **A new board from a template is a copy made in the browser**, the same path as an
  import (3.9): read the template's document over the collaboration connection,
  `boardToFile`, `parseBoardFile` with the clipboard rules, `createBoard`, write the pieces.
  Plugin blocks of unknown or disabled plugins are dropped and counted; plugin storage and
  poker rounds are not copied. No server-side copy, so the board document stays opaque to
  the backend. Later changes of the template do not reach the copies.
* Files on a template (images, PDFs) belong to the template board (S4.1). The copy fetches
  each through `getFileUrls` (`original` variant, same fetch options as pdf.js, URLs never
  stored) and uploads it with `uploadFile` to the new board; the server re-checks type,
  size, quota and scan. A file that cannot be copied leaves the block showing "not
  available".
* "Save as template" on any board makes a template copy (the retro board stays as it
  was); "Use template" is in the new-board dialog and on the Templates page.
* **Built-in templates** ship in the frontend image as typed board files, parsed by
  `parseBoardFile` at runtime and in a test, shown in their own group (instance templates
  show their owner): retros (Start/Stop/Continue, Mad/Sad/Glad, 4L), Kanban, Sprint
  planning, Brainstorming, User story map, SWOT.

### 3.13 Emojis (M5)

* The system's emoji font draws them; no emoji images are shipped (Twemoji and Noto
  graphics are not under a permissive licence, see the rules of the project).
* Picker: own Angular component, emoji data from `emojibase-data` (MIT), loaded as a
  lazy chunk on first use, served from the app (no CDN). Recently used emojis in
  localStorage (per browser, best effort), validated on read, at most 32 entries.
* In text: a button while a text is edited inserts at the caret.
* `core.emoji` block (stamp): props `{ emoji }`. The value is checked by an allowlist
  (well-formed, at most 32 UTF-16 units, only emoji characters with their joiners,
  modifiers, keycaps and complete tag sequences; no whitespace, bidi controls, letters or
  markup) on import, paste and template copy, and again on every read before rendering;
  rendered as text only. Used for reactions and dot voting in retros.

### 3.14 GIFs

* Search and insert GIFs from GIPHY. Each installation needs its own GIPHY API key
  (`DRAWBOARD_GIPHY_API_KEY_FILE`, a secret per deployment); without a key the feature does not
  exist (`CurrentUser.gifsEnabled = false`, 404 `GIFS_DISABLED`). The frontend has its own
  switch `GIFS_ENABLED`, which adds `https://media.giphy.com` to the CSP and sets `gifsEnabled`
  in `/config.json`.
* Search runs through the backend (`searchGifs`, `listTrendingGifs`): the key stays on the
  server, GIPHY sees the server's address, not the user's. Signed-in users only. Content rating
  per instance (`DRAWBOARD_GIPHY_RATING`, default `g`). A new GIPHY key is a beta key with 100
  calls per hour for the whole instance: results are cached, users are limited, and the
  instance budget (`DRAWBOARD_GIPHY_HOURLY_BUDGET`, default 90) answers 429 when used up.
* Block `core.gif`, props `{ giphyId, alt? }`. The image is loaded from GIPHY by the viewer's
  browser (no copy on the server), from a URL built from the id and a fixed base, and only
  after the viewer agreed ("Load" or "Always in this browser"), guests included.
* The block travels with export, import, data links, paste and template copies as the id only.
  Instances without GIFs, `/open`, image/PDF exports and thumbnails show a placeholder and
  load nothing.
* "Powered by GIPHY" is shown in the picker. Decisions G1–G16 in section 8.

### 3.15 Estimation sessions

Two moderated modes next to planning poker, for many cards at once; one resource
`EstimationSession` with `mode` in module `planning`, subdomain `sessions`.

* **Magic Estimation:** the cards (story blocks or kanban cards) are dealt evenly;
  in the placing phase everyone silently puts their own cards into a deck column, in
  the moving phase everyone may move any card; cards that were moved often or sit in
  "?" are marked and discussed in the review.
* **Rotation:** the cards are dealt evenly and wander in a ring for a fixed number of
  timed rounds. Each holder sees the previous estimate without its author and either
  keeps it or changes it with a reason. Reasons and all values become visible only in
  the review, with average and median; the team agrees on one of the values chosen.
* A moderator (editor or owner) creates the session, picks who is seated, may advance
  a phase early and records the decisions; the moderator sees nothing earlier than
  anyone else. Guests on commenter or editor links may take part, never moderate.
* Everything lives on the server (schema `planning`): seats, entries, moves, reasons,
  timers. Phases end by the server clock, applied lazily on the next request - no
  scheduler. Clients poll with ETags like poker; the Magic board is an overlay, not
  Yjs blocks. Nothing of a session is in the Yjs document, exports or templates.
* After "finish" a client with edit rights writes the decided values into the cards
  as ordinary editor updates (story `estimate`; kanban `estimate` and, for integers,
  `points`). Reasons and single values are dropped 30 days after the end; decisions
  stay. Rules: section 8, "Estimation sessions: design decision".

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

### M5 contract and design review: templates and emojis (Fable, 2026-11-12)

Review of the M5 contract (api `feat/board-templates`: `Board.template`, `NewBoard.template`,
`BoardUpdate.template`, `listTemplates`) and the design (3.12, 3.13) against S1.7, S1.8, S2.4,
S2.5, S4.1–S4.5, S5.2, S5.5, S6.5, S7.1, S7.3 and the M2–M4 and clipboard reviews. **Verdict:
release the contract as 2.1.0 after three text changes; design approved with the additions
below.** A template is metadata, the copy is an import, files go through the upload path: no
new trust boundary. The one real risk is an unscoped `listTemplates` (T4).

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | MUST | Planned `listTemplates` scans every template of the instance and resolves a role per candidate in memory; any user can flag unlimited boards as templates, so one user slows every list call for everyone | Candidates from the caller's grants only (T4), cap 1 000, 30/min per user |
| 2 | MUST | `BoardUpdate.template` names `FORBIDDEN` for an EDITOR; every other role failure of `updateBoard`/`moveBoard` is `LIBRARY_BOARD_ACCESS_DENIED` | One code, `required: OWNER` |
| 3 | MUST | 3.13 "no whitespace or control characters" would refuse ZWJ and tag sequences (both Cf) or, read loosely, admit bidi controls | Allowlist validator (E1), also on read |
| 4 | MUST | 3.12 does not say the copy is validated; `boardToFile` → `writeBoardFile` without `parseBoardFile` would write an editor-written document unchecked | Copy = import path with clipboard rules (T5) |
| 5 | SHOULD | Instance templates are indistinguishable from built-ins in a picker | Own group for built-ins, owner name on instance templates (T7) |
| 6 | SHOULD | A copy with many files runs into 30/min and the byte budget without warning | Show count and bytes, offer "without files" (T9) |

Decisions (templates):

* **T1** `template` grants nothing: reading, copying, editing, sharing and trashing follow the
  board's roles (`AccessResolver`); the server never copies a board document or a file. Guests:
  `listTemplates` 403, no copy (no `createBoard`, S1.8 unchanged); the flag is visible to anyone
  who can `getBoard`.
* **T2** Flag set by the OWNER only (create: creator; update: OWNER, an EDITOR with a different
  value → 403 `LIBRARY_BOARD_ACCESS_DENIED`); every change is an audit event
  (`BoardTemplateChanged`, S7.1) and raises `version`.
* **T3** `listTemplates` shows exactly the boards with `boardRole ≥ VIEWER` at request time:
  groups from the current token (S6.5), LINK_USER while the link is usable, trash excluded
  (board or folder above). Rows are the same `Board` as `getBoard`, nothing more.
* **T4** Bounded work: candidates = own boards ∪ boards with a grant for the caller (USER,
  GROUP of the token, LINK_USER; `findForPrincipal` as `listSharedWithMe`) ∪ boards in the
  subtree of folders with such a grant; `template = true AND deleted_at IS NULL` in SQL with a
  partial index, newest first, ≤ 1 000 candidate rows per call, page ≤ 100, 30/min per user
  (refusals are metrics, never audit); `boardRole` per candidate as the final check.
* **T5** The copy is an import (S5.5 extended): `boardToFile` → `parseBoardFile` with the
  clipboard rules → `writeBoardFile` in pieces (S2.5). Plugin types of enabled plugins pass
  through `pluginProps`; unknown or disabled types and their connectors are dropped and counted,
  never written raw and never a reason to refuse the copy. Plugin storage and poker rounds are
  not copied; `pokerRoundId` never travels.
* **T6** Files only through `getFileUrls` (template, VIEWER) → `fetch` with `credentials:
  'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'` → `uploadFile` (new board,
  OWNER) with the stored original name, `original` variant only; the server re-checks type,
  size, quota, scan and conversion. Signed URLs are never stored, logged or written into the
  document (S4.4); files over the caps are skipped before download; serial, 429 `Retry-After`
  honoured; a failed file leaves "not available". No "copy file by id" route: one would need
  VIEWER on the source, EDITOR/OWNER on the target, the target owner's quota and a new review.
  Confidentiality is unchanged (a VIEWER can already export and download); the quota spent is
  the copier's.
* **T7** Built-in templates pass `parseBoardFile` at runtime as well as in the test, hold no
  `core.file` and no plugin types, are shown in their own group; instance templates show the
  owner's display name.
* **T8** No `sourceTemplateId` in the contract (unverifiable, or an existence oracle). The copy
  is audited as `board.created` plus `file.uploaded` per file; reads are not audited. A template
  deleted or revoked during a copy ends the session (4403/4410) and the copy is discarded like
  a failed import.

Decisions (emojis):

* **E1** The emoji validator: well-formed, 1..32 UTF-16 units, only emoji characters
  (`\p{Extended_Pictographic}`, regional indicators, keycaps) with the joiners, variation
  selector, modifiers and complete tag sequences they need; excludes control characters, bidi
  controls, whitespace, letters and private use. Applied in `board-file.ts` (import, clipboard,
  template copy) and again on every read of `props.emoji` before rendering (S5.2: peers write the
  Y.Map directly); invalid = placeholder. Rendered via `textContent` in an element with
  `unicode-bidi: isolate`; `text` on `core.emoji` ignored.
* **E2** Picker data only from the app bundle (`'self'`, lazy), no runtime network; glyphs,
  names and keywords via `textContent`/interpolation, no `innerHTML` or
  `bypassSecurityTrust*`; CSP and Trusted Types unchanged.
* **E3** localStorage recents: one key, array of strings, read in try/catch, each entry through
  the validator, ≤ 32 entries, anything else discarded; nothing else is ever written. Accepted:
  recents outlive logout on a shared browser (not a secret).
* **E4** Stamps for reactions and dot voting carry no authority; counts are display only.
  `emojibase-data` MIT, no glyph images (project rule).

**Contract changes before 2.1.0:** (1) `BoardUpdate.template` and the `updateBoard` description:
`403 LIBRARY_BOARD_ACCESS_DENIED` (required OWNER) instead of `FORBIDDEN`; (2) `Board.template`:
"grants nothing … the server never copies a board or its files"; (3) `listTemplates`: `429`
response, "at most 100 per page, 30 calls per minute per user", "only what getBoard would show".
2.1.0 was released before these texts were in; they follow as a docs-only change (api!8,
no generated code changes).

**M5 in production only when:** `listTemplates` is grant-scoped and capped (T4) with a test that
a user with no grants sees only their own templates and that 1 001 templates of a stranger cost
one bounded query; the copy path has a test that a plugin block of a disabled plugin and an
invalid `props.emoji` from the template never reach the new document; a copied file is a fresh
upload (new id, new scan, no URL in the document); the emoji validator refuses U+202E, U+0009
and a bare U+FE0F and accepts a ZWJ family, a keycap and a flag tag sequence; the frontend names
the released contract 2.1.0.

### M5 frontend review: emojis (Fable, 2026-11-12)

Review of frontend!52 `feat/emojis` (6285ff4: `core.emoji` stamp block, `isValidEmoji`,
emoji tool, picker on `emojibase-data`, emoji insert into an edited text with `hold`) against
3.13, S5.2, S5.5, S5.6, S3.12, S7.5, S2.4 and the M3/M4 and clipboard frontend reviews.
**Verdict: approved, merge as is; no MUST.** Every claim held in code; the twelve touched spec
files (235 tests) pass. SHOULD 1 before `deploy:prod`, SHOULD 2 optional; both are fixed in
the same MR.

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | SHOULD | `emojiFontSize` scales the glyph with `min(w, h)` and peers' `w`/`h` are only checked for finiteness: a hostile editor's `1e9 × 1e9` stamp makes every viewer rasterise a glyph of ~8e8 px; the first block whose paint cost follows a peer-controlled size | Cap the block-space font size (2048 px; zoom is a transform), test with `1e9` |
| 2 | SHOULD (optional) | The validator accepts tag characters after any pictograph (≈ 14 hidden ASCII characters per stamp) and text-like pictographs | Tags only as a complete sequence after `U+1F3F4` |

Decisions:

* **`core.emoji` (S5.5 extended):** props `{ emoji }`, validated on import, paste and write
  by `isValidEmoji` (length checked before the regex, so no ReDoS); rendered through
  `textContent` only, constant styles, no image assets. An invalid value from a peer shows
  `❔` and is exported as `❔`, so our export always passes our import. Clients without the
  type render the placeholder and refuse a file with it, like for every new type.
* **Text insert:** goes through the editor's textarea (`setRangeText` + the typing path):
  one Yjs transaction, `textMaxLength`/`MAX_TEXT_LENGTH` enforced, single-line titles keep
  stripping newlines. `hold()` only suppresses the blur-stop; `stop()`, Escape and a live
  role change (`setReadOnly(true)`) end a held edit. Neither call is exposed to plugins.
* **Guests:** VIEWER/COMMENTER links stay read-only at three layers (toolbar, `setTool`,
  tool `pointerDown`) and never see the text-edit emoji button; EDITOR links gain nothing
  beyond the Yjs write rights S2.4 already grants.
* **Picker:** `emojibase-data` 18.0.0 (MIT, npmjs, integrity pinned, no install scripts),
  `en/compact.json` as a lazy same-origin chunk, Trusted Types unchanged; the localStorage
  "recent" list is re-validated element by element and capped on read.

### M5 backend review: templates (Fable, 2026-11-13)

Review of backend `feat/board-templates` (eceb59e, c5a75e1: `Board.template`, `createBoard`/`updateBoard`
with the flag, `listTemplates`, V5, `WindowRateLimiter` 30/min, metric `drawboard.templates.list.refused`)
against T1–T8, S1.7, S1.8, S6.5, S7.1, S7.3 and the M2–M4 reviews. **Verdict: merge after the one MUST;
T4 is met once the traversal is capped like the result.** Guests get 403 at the route and in the service;
the flag is changed by the OWNER only, before the version check, audited as `BoardTemplateChanged`;
candidates come from `findForPrincipal` (USER, GROUP of the token, LINK_USER) plus the subtree of granted
folders, one SQL statement with `LIMIT 1000` on two partial indexes, the role per candidate from
`AccessResolver` (revoked links lose their grants, expired ones fail `usable`, trashed folders cascade
`deletedAt` onto their boards).

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | MUST | `subtreeOf` and the `IN` lists are bounded in depth only: 33 000 subfolders (or 33 000 board grants) shared with a victim exceed the 32 767 bind parameters of R2DBC Postgres, so the victim's `listTemplates` is 500 for good and they cannot remove the grant; below that it is attacker-sized DB work 30/min | Cap the traversal (`MAX_TEMPLATE_FOLDERS`, 1 000, per call) and the number of board grants, document "the first N", unit test with a wide tree, integration test that a shared non-template board is not listed |
| 2 | SHOULD | `visible.drop(page.offset.toInt())` overflows for large `page` → 500 | `coerceAtMost(visible.size)` |
| 3 | SHOULD | V5 adds `template NOT NULL` without a default: after a failed rollout the previous image can no longer insert boards | `ADD COLUMN … NOT NULL DEFAULT false`, keep the default |
| 4 | SHOULD | `boardRole` walks the ancestors before the owner shortcut, 1 000 times per call | Owner check first, memoize ancestors per folder within one call |

Decisions: **T4a** bounded work means every list the request builds is capped, not only the rows the
statement returns: folders visited, grants taken, bind parameters per statement. **T4b** No audit for 429
(metric only), no personal data in the metric label. **T2** confirmed as implemented: an EDITOR who sends the
current value is not refused; a different value is `LIBRARY_BOARD_ACCESS_DENIED` with `required: OWNER`,
checked before `CONFLICT`. **V5** keeps `DEFAULT false` as a deliberate exception to "no defaults in the
database": the previous image must still insert boards after a failed rollout.

### M5 frontend review: templates (Fable, 2026-11-13)

Review of frontend `feat/templates` (c99582c, de0144e: Templates page, new-board dialog with
picker, built-in templates, `importableCopy`, `BoardTemplates` with file copy, "Save as
template", owner switch) against T1–T9 of the M5 design review, 3.9, 3.12, S4.1, S4.4, S4.5,
S5.5/S5.6, S6.9, the clipboard review and the M2–M4 frontend reviews. **Verdict: approved,
merge as is; no MUST.** T5, T6, T7 and T9 are met. SHOULD 1 is optional; it is fixed in the
same MR.

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | SHOULD (optional) | `importableCopy` drops bad blocks one by one, but the whole-file parse still refuses structure a hostile peer can write into the Y.Doc (parent missing or not a frame, frame cycle, depth > 8, connector end on a missing block) where the engine renders it degraded; an EDITOR of a shared template makes it uncopyable | Resolve such parents to `null` and drop such connectors, counted as skipped, before the whole-file parse; refuse only schema version and duplicate ids |

Decisions:

* **T5 met:** the copy is `boardToFile` → plain JSON → per-block `parseBoardFile` (unknown or
  disabled types and invalid props dropped and counted, their connectors too, children of a
  dropped frame become top-level) → whole-file `parseBoardFile` → `writeBoardFile` in pieces.
  Plugin types come from `listEnabledPlugins`; a failed list means no plugin types (fail closed);
  `core.*` never passes the plugin path. Built-ins take the same path at runtime and in a test.
* **T6 met:** `getFileUrls` of the source (server role check), `original` only, URL form
  checked, `fetch` with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`,
  `redirect: 'error'`; size from metadata before the download and from the blob after; serial;
  429 with `Retry-After` capped at 60 s, three retries; signed URLs only in the throw-away
  `BoardFiles` injector, never in the document, toasts or spans. The reader connection stays open
  during the copy: 4403/4404 (`denied`) and 4410 (document replaced) cancel the copy before the
  next file and the half board is deleted like a failed import.
* **T7 met:** built-ins in their own group; instance templates show the owner's display name
  from `listBoardMembers` of a board the caller may already open (VIEWER); nothing a caller
  could not fetch anyway. **T9 met:** count and bytes from `listFiles`, "copy without files"
  leaves the file blocks out without touching a file.
* Owner switch only in the owner's menu and enforced by the server (403, 409 refetch); guests
  see no menu. No `innerHTML`, no `bypassSecurityTrust*`, no storage; everything rendered by
  interpolation. Accepted: after a mid-copy revocation the half board with its re-uploaded files
  sits in the copier's trash until purge (the copier could download them while a VIEWER).

**Open before `deploy:prod` of M5:** once `feat/emojis` and `feat/templates` are both on
`main`, the test from the design review that an invalid `props.emoji` in a template never
reaches the new document (through `importableCopy`).

### GIF search via GIPHY: design decision (Fable, 2026-11-13)

Design review of GIF search and a `core.gif` block (3.14) against S1.8, S3.5, S4, S5.2, S5.4–S5.7,
S7.2, S7.3, S7.5, S7.8 and the M5 reviews. **Verdict: approved as a built-in block that hotlinks
GIPHY behind a per-viewer click-to-load, with search through a backend proxy for signed-in users.**
Checked 2026-11-13: `https://media.giphy.com/media/<id>/{giphy,200w}.webp` answers 200 without a
redirect, with `Access-Control-Allow-Origin: *` and without cookies. GIPHY's terms could not be
read; a server-side copy is therefore not approved.

| # | Level | Decision |
|---|---|---|
| G1 | MUST | Key from `DRAWBOARD_GIPHY_API_KEY_FILE` (or `DRAWBOARD_GIPHY_API_KEY`, file wins). Missing or empty = GIFs off; present but not `^[A-Za-z0-9]{16,64}$` = startup fails. No call to GIPHY at startup. |
| G2 | MUST | The key never reaches a browser, log, span, metric, audit event or error body. GIPHY takes it as a query parameter: the GIPHY client runs without HTTP client observation (own span: host and outcome only), exceptions are mapped without message and URI, the holder has a redacted `toString`. A test asserts the key is in no log line and no span for success, 401, timeout and 5xx. |
| G3 | MUST | Two switches, both fail closed: backend key → `CurrentUser.gifsEnabled`; frontend `GIFS_ENABLED=true` → `gifsEnabled` in `/config.json` and the CSP source. Picker needs both; rendering needs the config flag (guests have no `CurrentUser`). Helm drives both from `gifs.enabled`. SHOULD: admin hint when they disagree. |
| G4 | MUST | Upstream fixed to `https://api.giphy.com/v1/gifs/{search,trending}`, no redirects, 2 s connect, 5 s response, 2 MB body. Sent: key, `q`, `limit=24`, `offset`, `rating`, `lang`; never a user or client identifier. The answer is mapped to `{id, title, width, height}` and validated; no GIPHY URL is passed on. Backend egress 443 in the NetworkPolicy only with `gifs.enabled`. |
| G5 | MUST | Search for signed-in users only; guests 403, also with an EDITOR link (S1.8 unchanged). Guests can still move, copy and paste GIF blocks. |
| G6 | MUST | Rating per instance: `DRAWBOARD_GIPHY_RATING` = `g` (default), `pg`, `pg-13`; never a client parameter. It filters search only: any editor can write any `giphyId` into the document; accepted because of G10. |
| G7 | MUST | Limits (`WindowRateLimiter`), order disabled → principal → validation → user → cache → instance → upstream: 10/min and 40/h per user (429 `TOO_MANY_REQUESTS`); `DRAWBOARD_GIPHY_HOURLY_BUDGET` (default 90, beta keys have 100/h) on upstream calls (429 `GIFS_BUDGET_EXHAUSTED`, also for GIPHY's own 429). Cache per (normalised q, page, rating, lang) 15 min, ≤ 500 entries; trending 30 min. SHOULD: single-flight, failures cached 30 s. Frontend debounce ≥ 400 ms, ≥ 2 chars. |
| G8 | MUST | Search terms in no log, span, metric label or audit event: search is `POST /gifs/search` with a body. Metric `drawboard_gifs_requests_total{outcome}` only. |
| G9 | MUST | `core.gif`, props `{ giphyId, alt? }`: id `^[A-Za-z0-9]{1,64}$`, alt plain text ≤ 200. Validated on import, paste, template copy, export and on every read before a URL is built. URL = `https://media.giphy.com/media/<id>/` + `200w.webp` or `giphy.webp` (constants). `<img crossorigin="anonymous" referrerpolicy="no-referrer" loading="lazy" decoding="async">`, no `srcset`; only in the viewport, ≤ 30 loaded at once. |
| G10 | MUST | Click-to-load per viewer, guests included: placeholder "GIF from GIPHY – loading sends your IP address to GIPHY" with "Load" (board, session) and "Always in this browser" (localStorage, validated, revocable). The picker asks the same before showing previews. No instance-wide auto-load. |
| G11 | MUST | Never loaded, placeholder only: instances without `gifsEnabled` (data kept), `/open` data links (S5.6), PNG/SVG/PDF export, board thumbnail. Built-in templates hold no `core.gif` (T7). |
| G12 | MUST | CSP `img-src` gains exactly `https://media.giphy.com`, only with `GIFS_ENABLED=true`; no wildcard, no other directive. Header test for both states. Another host needs a review. |
| G13 | MUST | No server-side download, copy or proxying of GIPHY media; `core.gif` never becomes a `core.file`. A copy route needs GIPHY's terms read and a new review. |
| G14 | MUST | Built-in, not a plugin: a plugin bundle may hold no secret (S3.5) and plugin frames load no third-party images (S3.3). |
| G15 | SHOULD | "Powered by GIPHY" in the picker, "GIPHY" on placeholder and block, as text or a shipped asset, never fetched. |
| G16 | SHOULD | The operator's privacy notice names GIPHY (viewer IP on load, search terms from the server's IP). |

Accepted: a viewer who clicks "Load" tells GIPHY IP address, user agent and which GIF; without
cookies or referrer. GIPHY may change or remove what an id shows. A hostile editor can place GIFs
outside the instance rating.

**Before enabling in production:** G1–G13 implemented, the key-leak test (G2) and the CSP test
(G12) green, GIPHY's API terms read by Georg (hotlinking, attribution, caching of results).

### GIF backend review (Fable, 2026-11-13)

Review of backend `feat/gifs` (ccc2e03, badd229: module `gifs`, `GifsApi`, route table, compose secret
`giphy_api_key`) and gitlab-devops script 40 against G1–G8, G13, S1.8, S7.3, S7.8. **Verdict: approved, no
MUST in the code; merge under the rollout condition below.** Tests read, not re-run by the reviewer.

* MUST (rollout): the file `giphy_api_key` exists on dev and prod before the merge (stack 72 follows `main`
  within 5 min; a missing secret file stops the stack) and is EMPTY on prod until "Before enabling in
  production" of the design decision is complete. Script 40 writes an empty prod file unless it is called
  with `--prod-freigabe`; `--pruefen` shows `prod: leer` and `GIFS_ENABLED=false` on `drawboard-frontend`.
* SHOULD: pin `org.springframework.http.codec` and `org.springframework.core.codec` to INFO in
  `application.yaml` - at DEBUG Spring's Jackson decoder logs `Decoded [<body>]`, which would print the
  search text (and every other JSON body, S7.2). Add both loggers at DEBUG to the leak test. Due before a
  prod key is entered.
* SHOULD: script 40 says after `--ersetzen` that the backend stack must be redeployed (the key is read once
  at start; "off" is not off before that) and names the precondition at the prod prompt. (Done.)
* SHOULD: the leak test also covers GIPHY's 429 and connection refused.
* G1 met: file wins over the variable; empty, blank or missing = off; wrong shape or unreadable file stops
  the start without naming the value; no call to GIPHY at start.
* G2 met: redacted holders; the GIPHY client is `WebClient.builder()` over the JDK `HttpClient` (no
  observation, no OTel agent, no client span, no `traceparent`); Spring 7 logs the request without its query
  even at DEBUG; every failure is an `UpstreamFailure` with a fixed word, no cause, no stack trace; actuator
  exposes `health,info` only, on its own port; the key is a file secret (uid 10001, 0400), never in compose.
  The two ArchUnit exceptions for `java.time.Duration` in `GiphyUpstream` are accepted.
* G4 met except the NetworkPolicy (Helm, open): constant host, no redirect, 2 s connect, 5 s total, 2 MB,
  strictly encoded parameters, mapping to `{id, title, width, height}` with validation, no GIPHY URL passed on.
* G5 met: `signedIn` in the route table plus the check in `GifsApiService`; guests 403 also with an EDITOR
  link (S1.8 unchanged).
* G6 met: rating from configuration only; `r` stops the start.
* G7 met (backend): order disabled → principal → validation → user (cache hits count) → cache → budget →
  GIPHY; budget reserved before the call, failures count; GIPHY's 429 blocks for its `Retry-After`
  (1 s–1 h, default 60 s); single flight; failures cached 30 s. Accepted: contract validation answers 400
  before 404 on an instance without a key; limits and cache per replica; a refused key costs one call per new
  search text until the budget is used up.
* G8 met: POST body, redacted `toString` on command and cache key, no span attribute, metric label `outcome`
  only, no echo of the value in errors, `Cache-Control: no-store`.
* G13 met: no download, copy or proxy route.
* Still open before production: G3 (frontend switch, Helm, admin hint), G4 NetworkPolicy, G7 frontend
  debounce, G9–G12 with the CSP header test, G15, G16, GIPHY's terms read by Georg.

### Kanban story cards review (Fable, 2026-11-19)

Review of frontend!63 (`feat/kanban-stories`, 97e33a8: story cards dragged into kanban columns,
card fields `description`, `criteria`, `estimate`, the card editor, the way back as a story
card, the lock during an open poker round) against 3.10, S2.5, S5.2, S5.5/S5.6, S7.6, T5, the
M4 frontend review and the clipboard review. **Verdict: merge after MUST 1**; SHOULDs 2 and 3
before the next production deploy, 4 and 5 optional.

| # | Level | Finding | Fix |
|---|---|---|---|
| 1 | MUST | A kanban no longer fits one UPDATE frame (S2.5): one maximal card is 110 KB as a Yjs update, 10 of them exceed 1 MiB, a full kanban is 55 MB. Dropping ~10 stuffed story cards is one transaction: the provider drops its queue and demands a reload (as clipboard MUST 1). On import and template copy a kanban is one piece (`splitBoardFile`: a single item may exceed the piece size); the provider drops it, `whenFlushed` resolves, and the import reports success without the kanban | Budget per kanban: `KANBAN_LIMITS.maxDetailBytes` (256 KiB UTF-8 over all descriptions and criterion texts), enforced in `addStoryCards`, `updateCard`, the file validator (refuse) and `readKanban` (details beyond it read as empty); a test that a maximal kanban and a maximal drop stay < 1 MiB; the importer fails when the provider reports `reloadRequired` |
| 2 | SHOULD | The drop lock needs the card's own `pokerRoundId` and the server's pairing; any editor can clear the hint | Lock on `EstimateSource.isOpen(blockId)` alone |
| 3 | SHOULD | `planStoryDrop` walks all blocks and reads the whole kanban on every pointer move; one fat kanban makes story drags stutter for everyone | Hit test only while moving; count the room once at pointer up |
| 4 | SHOULD (optional) | A kanban hidden under another block still takes the drop | Refuse when a non-dragged block with a higher `z` covers the point |
| 5 | SHOULD (optional) | Moving a card out as a sticky drops description and criteria silently | Toast, or a story card when the card has details |

Decisions:

* **Card details (S5.5 extended):** `description` (≤ 10 000), `criteria` (≤ 50, text ≤ 500,
  unique UUID ids), `estimate` (a deck value, `isValidEstimate`) are validated on every read
  from the document (`readKanban`, shared `readCriteria`), on every write, and on import, paste
  and template copy with the story card's own validators. A card never carries a `pokerRoundId`;
  a story card made from a card starts with `pokerRoundId: null`.
* **S2.5 refined:** a single block must fit one UPDATE frame. Block types with unbounded
  children (kanban) carry a byte budget that the validators and the models enforce; "write in
  pieces" assumes it.
* **S5.2 met:** the new fields reach the DOM only as `textContent`, `title` and form values;
  no style value comes from them.
* **S7.6 kept:** no vote or round data reaches the document. The lock during an open round is
  a convenience bound to the server's pairing (SHOULD 2), not a control: deleting a story card
  with an open round stays possible, and the reveal then writes nothing.
* **Drop = delete + add, one transaction, one undo step.** Connectors attached to a dropped
  story card are deleted with it, as with Delete; undo restores them. Accepted.
* **Guests (EDITOR link)** gain nothing beyond their Yjs update rights; read-only clients
  cannot drop, save or move out. S2.4 and S2.7 hold unchanged; document growth is bounded by
  the server's log limit, as for text blocks.

### Estimation sessions: design decision (Fable, 2026-11-19)

Review of the design for estimation sessions (Magic Estimation and Rotation, module
`planning`, subdomain `sessions`; no code yet) against 3.10, S1.7, S1.8 (M4), S1.10,
S1.13, S2.4, S2.6, S5.2, S7.1, S7.3, S7.6, S7.7, the M4 reviews and "Quick poker
rounds". **Verdict: approved as a design with the changes below; the contract is
written from this entry and reviewed before its release.**

Anonymity and visibility

* E1 MUST `anonymous` (default true), deck, items and settings are fixed at creation
  and shown in the lobby before anyone joins; no operation changes them.
* E2 MUST Slots are assigned by the server at start with `SecureRandom` and never
  leave it: no slot, holder or owner of a card other than the caller's own (`mine`)
  in any answer, error, audit event, log, span or metric.
* E3 MUST Before REVIEW, progress is published per seat only (`done`), never per card:
  no `entryCount`, no `placed` of other seats' cards (per card + per seat together
  reveal the ring). `version` rises when a seat's `done` flips, not per entry.
* E4 MUST Rotation before REVIEW: the holder sees the latest earlier value of a card
  as `currentValue`, without author, reason, round or history; nobody else sees any
  value, the moderator and the OWNER included. Magic PLACING: only one's own columns;
  MOVING: columns, `moveCount`, `marked` for everyone with access; the mover is never
  named, in any mode, also with `anonymous=false`.
* E5 MUST From REVIEW: entries of a card are returned in a stored random order,
  without entry id, round or timestamp; with `anonymous=true` without names. On
  entering REVIEW with `anonymous=true` the server nulls `entry.seat_id`,
  `move.seat_id` and `seat.slot` (magic moves always); with `anonymous=false` the
  names are shown and the mapping goes with the 30-day purge.
* E6 Named limits (documented in the UI text of the lobby): the next holder sees the
  previous value; the first entry of a card is recognisable (no reason, not kept);
  small teams can guess; a DB admin can map until REVIEW.
* E7 MUST Rounds ≤ seated participants at start, so nobody holds a card twice.

Guests (S1.8, S1.10)

* E8 MUST Guests with a COMMENTER or EDITOR link: list (ACTIVE), get, join, leave,
  placement, estimate, on the board of their link or below their folder (S1.7).
  VIEWER-link guests 403 on everything. Never create, start, advance, decide, finish,
  cancel. Guests join only by `joinEstimationSession`, never by GET.
* E9 MUST A guest sees LOBBY and running phases of every session of the board, but
  REVIEW, DONE and CANCELLED only when its session holds a non-removed seat (else 404
  `PLANNING_SESSION_NOT_FOUND`, also in the list). `moderatorId` absent for guests;
  seat ids are session-local random UUIDs; names as stored at join with `guest: true`.
* E10 MUST Caps: 30 seats, 15 guests, 10 per link (409 `PLANNING_SESSION_FULL`);
  guest limits keyed by share as well as session.
* E11 MUST Revoking a link (S1.13): LOBBY removes its seats; in a running phase the
  seat is marked removed, its rotation entries and reasons are deleted, its magic
  placements cleared, its move rows deleted and every card it touched set `marked`;
  removed seats never block "all done"; `version` rises. From REVIEW on the record
  stands (it is unattributable, E5); moderator or OWNER can cancel. Start and the
  step into REVIEW drop seats of revoked shares again (safety net, M4 backend
  SHOULD 5). A member who loses access keeps entries made while allowed.
* E12 MUST Reasons and titles: text only, one line, NFC, Cc/Cf refused, reason ≤ 280,
  title ≤ 200; rendered with `textContent`, never linkified, never copied into the
  document, toasts, spans, Faro or local storage.

Moderator

* E13 MUST Moderator = creating EDITOR/OWNER while still EDITOR/OWNER, or the board
  OWNER; checked per request; 404 for the session before 403. No privileged view, no
  editing of others' entries, no extend or pause. Rotation decision ∈ values entered
  for that card (any deck value only when the card has no entry, then `overridden`);
  magic decision ≠ column on an unmarked card is `overridden`; both server-enforced.

Time, load, locks

* E14 MUST Only the server clock decides: no client time in any request; `advance`
  carries the expected `{state, round}` (else 409); transitions never go back; a
  write after the deadline is 409 without grace; estimate and placement carry the
  expected round/state (SHOULD).
* E15 MUST `settle` is re-checked under the session lock (thirty clients polling at 0
  cause one transition); the `If-None-Match` comparison happens after settle; the 304
  path reads the session row only. Lock order board → session, separate `KeyedLocks`
  instances, lazy idle-cancel never takes a session lock while a board lock is held
  in the other order. One replica (M4 backend SHOULD 7 unchanged; SHOULD `@Version`
  on the session row so a second replica fails loudly).
* E16 MUST Limits: 3 active sessions per board, 100 closed, 1–50 items, 2–30 seats,
  rounds 1..min(10, seats), phase times 30–900 s (magic moving ≤ 1800 s), entries ≤
  500. Magic: per seat ≤ 5 moves per card and ≤ 3 × items moves in total (409
  `PLANNING_MOVE_LIMIT_REACHED`), 5000 per session as backstop; `marked` counts at
  most 2 moves per seat and card (SHOULD).
* E17 MUST Rates (S7.3), per user and, for guests, per share: create 10/min; list
  30/min per board (share 300); get 75/min per session incl. 304 (share 600);
  join/leave 10/min (share 30); placement 60/min (share 300); estimate 30/min (share
  150); moderator operations 120/min. 429 with `Retry-After`, metrics only. The list
  returns summaries, never items, seats or entries.
* E18 Transport: ETag polling stays (2 s, magic MOVING 1 s, pause while hidden,
  back-off on 429, SHOULD 0–500 ms jitter at a deadline). No WebSocket frame. Answers
  `no-store`, `Vary: Authorization`, `If-None-Match: *` is no match.
* E19 Awareness poke allowed as in "Quick poker rounds": field `estimation: <counter>`
  and nothing else. MUST raised only by the client that performed create, start,
  advance, decide, finish or cancel - never on join, placement, move or estimate (the
  relay names the sender). Receivers with access re-list (throttled 5 s) and nothing
  else; no id in the payload. MUST no cursor, drag, selection or "in estimation"
  state of the overlay in awareness; the chip derives from the server's seat list.

Document, records

* E20 MUST S7.6 holds: sessions, seats, entries, moves, reasons and results live only
  in schema `planning`; the server never reads or writes the Yjs document; refs are
  untrusted hints checked for form and unique per session; no session id, value or
  reason in the document, `.drawboard` files, templates, versions or board copies.
  The Magic board is an overlay, not Yjs blocks. Descriptions and criteria are read
  live from the document by ref, never copied to the server.
* E21 MUST Results are written by a non-read-only client from the DONE session only:
  the decided value, only when block, block type and (kanban) card exist and match
  the ref; story `estimate` via `isValidEstimate`, kanban `estimate` and `points`
  only for an integer 0..999; any editor who can read the session may do it later.
  SHOULD show the live title next to the stored one and the card's current value
  before overwriting. No `PLANNING_ITEM_BUSY`: a card in two sessions is a UI hint.
* E22 MUST Retention: cancel and idle-cancel delete entries, reasons and moves at
  once; 30 days after DONE no answer contains single values or reasons any more
  (enforced on read; deletion by the daily purge, SHOULD), decisions and aggregates
  stay; everything follows the board (trash 404, purge S7.7); deleted users read
  "Deleted user". Idle: 24 h in LOBBY and running phases; SHOULD 7 days in REVIEW.
* E23 MUST Audit (S7.1): session created (board, mode, item count, deck kind),
  started (seat counts members/guests), finished (decisions, overridden), cancelled,
  decision overridden (session and item id). Never values, reasons, moves, joins or
  seat-to-entry relations; refusals are metrics with fixed labels (S7.10).
* E24 MUST No regression of poker: the common refactor is a pure move (poker tests
  unchanged and green, `oasdiff` shows no change on poker operations, minor release);
  new routes are named one by one in the route table, the rest stays `denyAll`; the
  Playwright guest allowlist covers the new guest operations; board erase and share
  revocation call both use cases, one failing never skips the other.

Contract corrections (from the same review): `listEstimationSessions` returns summaries only (id,
mode, title, state, round, moderatorName, createdAt, seatCount, itemCount, `me.seated`), guests
403 on `state=CLOSED`; `startEstimationSession` `seatIds` 2..30, unique, non-removed, rotation
`rounds ≤ seatIds.size`; `placeEstimationItem` `{value, state?}`, `null` only in PLACING;
`setRotationEstimate` `{value, reason?, round?}`, same value = kept (a reason is discarded),
returns `myEntry` only; `advanceEstimationSession` `{state, round}`; cancel from every non-closed
state. Authorisation order: board role (404) → VIEWER-link guest (403) → session (404) → role or
seat (403) → state (409). `EstimationItem` without `entryCount` and `placed`; `column`,
`moveCount`, `marked` from MOVING (PLACING: `column` only for `mine`); `currentValue`, `myEntry`
holder only in ROTATING; `result`, `decision`, `overridden` from REVIEW. `EstimationSeat`
`{id, displayName, guest, seated, done}` sorted by join time. `EstimationEntry` without id,
round, time. `moveTrail` values only. All arrays `maxItems`, strings `maxLength`, objects
`additionalProperties: false`. `PLANNING_NOT_SEATED` is 403; `PLANNING_ITEM_NOT_HELD` identical
for "other seat" and "other round"; `PLANNING_ITEM_BUSY` dropped. V3: entry `shuffle` key,
`seat_id` nullable, move `seat_id` nulled at REVIEW, seat `slot` nulled at REVIEW when anonymous,
item flag "touched by a removed seat".

**Estimation sessions with guests in production only when:** the contract and code
reviews have passed, one revoke on dev has been seen to remove a link's seat and
entries from a running session, the guest allowlist test runs in the pipeline, and a
test proves that no answer before REVIEW differs per card for a non-holder (E3).

### Estimation sessions: contract review (Fable, 2026-11-19)

Review of the contract (api `feat/estimation-sessions`, c49559e, built as 2.3.0-local)
against E1-E24 and the contract corrections of the design decision, S1.8, S1.10, S7.3,
S7.6 and the M4 contract review. **Verdict: release as 2.3.0 after three changes.**
Guest allowlist (list ACTIVE, get, join, leave, placement, estimate for COMMENTER/EDITOR
links; VIEWER links 403; no moderator operation), visibility per state (E3-E5, E9),
rates (E17), ETag with `no-store` and `Vary: Authorization`, and the unchanged poker
operations (E24) are as decided.

* C1 MUST The pattern for titles and reasons must not backtrack: the form
  `^[^C]*[^\sC][^C]*$` is quadratic (250 000 characters = 174 s in `java.util.regex`),
  bean validation runs before authorisation and rate limit, and 1 MB bodies pass
  nginx - one request of any signed-in user or guest blocks a thread. Use
  `^[^\S\x00-\x1F\x7F-\x9F]*[^\s\x00-\x1F\x7F-\x9F][^\x00-\x1F\x7F-\x9F]*$` (first
  class disjoint from the second, linear). Rule for every future pattern in the
  contract: neighbouring repeated classes are disjoint.
* C2 MUST Order of refusals, the same for every operation: board role (404) ->
  VIEWER-link guest (403) -> session incl. E9 (404) -> role or seat (403) -> state and
  expected round (409 `PLANNING_SESSION_WRONG_STATE`) -> card held (409
  `PLANNING_ITEM_NOT_HELD`) -> value (400 `PLANNING_VALUE_INVALID`) -> reason (400
  `PLANNING_REASON_REQUIRED`) -> move limits (409). Only schema-level 400, which do
  not depend on the session, may come earlier. A reason check before the hold check
  would let a seated non-holder read `currentValue` of every card (E4).
* C3 MUST (amends E7) `startEstimationSession` refuses more seats than cards, in both
  modes (400 `VALIDATION_FAILED`, field `seatIds`): a seat without a card makes `done`
  tell holders from non-holders, with one card it names the holder of every round
  (E2, E3).
* SHOULD: a guest without a seat gets 404 `PLANNING_SESSION_NOT_FOUND` (params
  `sessionId` only) on every operation of a REVIEW, DONE or CANCELLED session, join
  and leave included, and the `If-None-Match` comparison happens after authorisation
  and E9 (`version` is guessable); `markThreshold` at least 3 (one seat counts 2
  moves per card and must not mark alone); `moveCount` at most 150; Magic
  `overridden` = unmarked card and value != column, a marked card is never
  overridden; a CANCELLED session has no `result`, `decision`, `overridden`, `column`,
  `moveCount`, `marked`; titles and reasons also refuse U+2028/U+2029, trim and blank
  check Unicode-aware on the server; "no reason needed" is tied to a card without
  `currentValue`, not to the first holder.
* Confirmed as written: `round` 0-based (MAGIC 0, last round kept from REVIEW);
  `seated` true for every joined seat in LOBBY, `me.seatId` also for seats not
  picked (only the caller's own), `EstimationSessionMe` in the summary (guests always
  `moderator: false`); removed seats are not listed; unknown `itemId` = 404
  `PLANNING_SESSION_NOT_FOUND` with `params.itemId` (never on the E9 404); wrong
  expected state/round = 409 `PLANNING_SESSION_WRONG_STATE`, `PLANNING_ITEM_NOT_HELD`
  with one body; Rotation accepts every deck value incl. `coffee`, Magic columns and
  decisions exclude it; decide, join, leave, placement 204, start, advance, finish,
  cancel 200 with the caller's view; finish with undecided cards; `moveTrail` <= 151,
  `entries` <= 10; 30 days after DONE `entries` and `moveTrail` are empty while
  distribution, average, median, candidates and decisions stay (unattributed counts);
  flat `EstimationSettings` with per-mode 400.
* For the backend review: absent `anonymous` is true; `no-store` on every estimation
  answer (the 200 of `setRotationEstimate` carries a secret value); the 200 bodies of
  start, advance, finish and cancel use the same per-caller view as get; a test for
  C2 (non-holder never gets `PLANNING_REASON_REQUIRED`) and C3; the purge reduces
  entries to counts; 600 gets per share and minute equal ten guests of one link at
  1 s in MOVING, so the client back-off on 429 must work.

### Estimation sessions: frontend review (Fable, 2026-11-19)

Review of the frontend (frontend `feat/estimation-sessions`, f0a8b47..bf4934d, contract
3.0.0) against 3.15, E1-E24, C1-C3, S1.8, S2.4, S5.2 and S7.6. **Verdict: merge after
F1 and F2.** Per-seat progress only (E3), server-only visibility with identical texts
for 403/404 (E4, E5), titles and reasons as interpolated text without toasts, spans,
Faro attributes or storage (E12), expected state/round on advance, placement and
estimate (E14), no awareness field and no poke (E19), write-back from DONE only with
matching block, type and card (E20, E21), VIEWER-link guests without any call and the
guest allowlist test (E8, E24) are as decided. The `EtagPoller` change (interval read
after the answer) does not alter poker, which passes a constant interval.

* F1 MUST Before REVIEW the estimation UI never changes the selection or the camera:
  "show on the board" in the Rotation panel selected the held card and centred the
  viewport on it, and both are published by name through awareness (S2.4) - one click
  per round names the holder and with it the ring (E2, E4, E19). The Rotation panel
  shows title and description itself; `focusRef` stays in the review only. Test: no
  panel interaction in ROTATING changes selection or camera. The lobby names the limit:
  what one selects or looks at on the board stays visible to others.
* F2 MUST The wait after a 429 (`Retry-After`, back-off) holds against `refresh()`,
  `pollSoon()` and the return from a hidden tab: the poller keeps a "not before" time
  and only re-arms its timer. No poll after an own placement or estimate (the tab keeps
  its own state; MOVING polls every second anyway) - otherwise ten guests of one link
  in MOVING exhaust the share budget and keep it exhausted (E17, E18).
* SHOULD: placement and estimate send the state/round the user acted in (state at
  pointer-down, round of the rendered card), not the one at send time; a drag is
  cancelled when the phase changes. The cast for `EstimationStart.seatIds` (generated
  as `Set`, sent as a de-duplicated array) is correct; the generator maps `set` to
  `Array` with the next contract release and the cast goes; a test asserts the body is
  an array.
* For the backend review: paths `/items/{itemId}/estimate` and `/placement` in server
  spans and access logs together with a user id are a holder or mover relation (E2,
  E4, E23) - no user id on these spans, or the item id masked in the route attribute.
* Not built: the awareness poke of E19; other clients learn of a new session when they
  open the board or the menu.

### Estimation sessions: backend review (Fable, 2026-11-19)

Review of the backend (backend `feat/estimation-sessions`, 06c6c8d..602a2a7 on backend!46, contract
3.0.0) against 3.15, E1-E24, C1-C3 with their SHOULDs, S1.7, S1.8, S1.13, S7.1, S7.3, S7.6, S7.7,
S7.10 and the M4 backend review. **Verdict: merge as one stack after two changes.** No holder,
mover or author relation in any answer, error, metric or audit event; refusal order C2, C3, E9 on
every operation, moderator rule E13, server clock and settle under the session lock (E14, E15),
limits and rates (E16, E17), retention on read (E22), audit details (E23), route table and both
use cases in erase and revocation (E24) and the text rules (E12, C1) are as decided.

* B1 MUST No caller identity in the trace of `placeEstimationItem` and `setRotationEstimate`: the
  spans carry `item.id` and the path, and every guest request has a `guestCaller` span with
  `share.id` - for a link used by one guest that is a holder or mover relation in Tempo, kept
  after the REVIEW nulling (E2, E5). Drop `share.id` from that span (or mask the item id in span
  attributes, `http.url` and the error log line); a test asserts that these traces hold no share,
  guest or user id. Members are not affected (no user id or client address on spans or log lines).
* B2 MUST Revocation in MOVING re-chains the remaining moves of a card: the first one's
  `from_value` becomes the original placement (null for a card dealt to the removed seat), so
  `moveTrail` holds nothing the removed seat entered (E11).
* SHOULD: entry and move ids random instead of UUIDv7, `created_at` of entries dropped and
  `moved_at` replaced by a sequence at REVIEW in anonymous sessions (time correlation with request
  logs); `slot` and `touched` cleared when a running session is cancelled; the rate limit of get
  keyed after the session was found, a limit before `header()` on the other operations; the E3
  integration test also for Magic PLACING; the frontend nginx logs the two item routes without
  the item id.
* Confirmed as built: revocation - LOBBY deletes the seat; running phases mark it removed, delete
  its entries, reasons and moves, clear the column of a card dealt to it unless a remaining move
  sets one, mark every card it touched, raise the version and end a round nobody else holds up;
  from REVIEW the record stands; start and the step into REVIEW drop seats of revoked links again.
  A Magic move replaces the same seat's previous move of that card within 10 s when nobody moved
  it in between (window from the first move). The 304 path reads the guest's own seat in REVIEW,
  DONE and CANCELLED (amends E15). `no-store` on errors comes from the security headers, `Vary`
  on success only. The retention purge runs in the trash cleanup interval. Metrics
  `drawboard.planning.sessions{event,mode}`, `.session.inputs{kind}`, `.session.refused{reason}`.
  One replica; every session update names the version it read (409 `CONFLICT` otherwise).
* Of "with guests in production only when": contract and backend review passed (after B1, B2), the
  backend guest allowlist and the E3 test run in the pipeline. Open: the frontend review and its
  Playwright allowlist, one revoke seen on dev in a running session.

### Plugin archive memory (Fable, 2026-11-21)

Review of backend!49 (`fix/plugin-archive-memory`, 5edaf99 + 9e9b9fc) against S3.9, S7.3 and the
M3 backend review. **Verdict: approved, deploy as is.** The ZIP is read twice from the same private
bytes: pass 1 applies every S3.9 rule in the old order with the old reasons and only counts (16 KiB
buffer, refused at the first byte over 50 MiB; the data of directory entries counts too, else
`nextEntry` inflates it unbounded); pass 2 reads the accepted files into arrays of the counted size
and refuses (NOT_A_ZIP) any name, size or entry set that differs - fail-closed, no header size is
ever allocated. Every `IOException` of the JDK reader is NOT_A_ZIP (a cut local header was a 500).
Peak per install ≈ 20 MB + 50 MiB (was ~2-3x), a hostile archive costs ≤ ~0.1 s CPU; with the upload
guard (2 in flight per user, 8 per instance) no further limit is required for an admin-only route.
* SHOULD (follow-up MR, before third-party plugins): unpack, manifest and digests inside the
  install lock or a 1-permit semaphore and off the Reactor thread, so only one 50 MiB result
  exists at a time (done in backend!50, see the next entry). Known and harmless: entries absent
  from the central directory skip the symlink bit check - nothing is ever extracted.

### Plugin archive serialisation (Fable, 2026-11-21)

Review of backend!50 (`fix/plugin-archive-serial`, 75dea1d on 9e9b9fc) against the SHOULD of
"Plugin archive memory", S3.9 and S7.3. **Verdict: approved, deploy as is; the SHOULD is
discharged.** Unpack, manifest and digests now run inside the install lock, before the transaction,
in `withContext(Dispatchers.Default)`: one unpacked archive (≤ 50 MiB) per instance at a time, and
no event-loop thread inflates or hashes. The block is not interruptible and `withContext` returns
only when it has ended, so a request cancelled mid-unpack keeps the lock until its arrays are
garbage - the bound holds for abandoned uploads too; a waiter that is cancelled leaves the (fair)
queue at once. Outside the lock only the raw upload waits (≤ 20 MB each, upload guard: 2 per user,
8 per instance): worst case ≈ 8 x 20 MB + 50 MiB, was 8 x 70 MB. The lock is held well under 1 s
longer than before (estimate; the transaction was already inside), installs stay at 10/min per admin,
taken before the lock - no further limit for an admin-only route. Reactor context (security, trace)
crosses the dispatcher switch unchanged, the transaction starts after it. Refusal order, reasons and
error codes are the same.
* No SHOULD left. Rules to keep: never register an `ArchiveUnpacker` bean (the service's optional
  constructor parameter would take it instead of `PluginArchive`; the type is module-internal and
  test-only), and keep `readBundle` free of suspension points and logging.
* Known and accepted: waiting for the install lock has no timeout (cancellable, capped by the
  upload guard); a hanging install transaction holds the lock, as before.

### GitHub sync: GIF test values (Fable, 2026-11-22)

The gitleaks gate of `sync:github` stopped on four `generic-api-key` findings in the GIF tests of
the backend (`main` at ea09caa). **Verdict: all four cleared, none is a credential.** Three are
keys made up for the tests, a word plus a counting sequence, 21-24 characters where a real GIPHY
key has 32: `VariableKey0123456789` (GifsBudgetIntegrationTest), `IntegrationKey0123456789`
(GifsSupport), `TestKey0123456789abcdef` (GifFixtures); the tests only ever send them to the fake
GIPHY and look for the text in logs, spans and answers. The fourth is no key at all: in
GifsConfigurationTest gitleaks reads the property `gifs.rating=PG-13` after `$TEST_KEY",` as the
value. History of the backend (all refs, gitleaks 8.30.1 with the default rules, plus every line
that ever named a GIPHY key): no real key was ever committed, nothing to rotate.
* `public/gitleaks.toml` allows exactly these four values, each anchored, for `generic-api-key`
  only. A new test key needs its own entry, or a name the rule does not match.

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
