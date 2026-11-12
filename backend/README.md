# drawboard-backend

Backend of **Drawboard**, a self-hosted collaborative whiteboard. Spring Boot 4.1.1,
Kotlin 2.3.21, Java 25, Gradle 9.7.1; hexagonal, cut into Gradle modules, reactive
(WebFlux + Coroutines + R2DBC), auditing and OpenTelemetry built in. Copied from the
house reference implementation (the sample backend) and adapted (see
`../CLAUDE.md` for the deviations from the house skills).

Belongs to [drawboard-api](../api) (the OpenAPI contract) and
[drawboard-frontend](../frontend): separate repositories, versioned and deployed
independently. Concept and phases: [../docs/architecture.md](../docs/architecture.md).

**Milestone M4** (this state) adds **planning poker** on story cards (module `planning`, section [Planning poker](#planning-poker)),
the **malware scan** of uploads (ClamAV, optional: [Files](#files)) and the **usage metrics** with their Grafana dashboard
(section [Metrics and the dashboard](#metrics-and-the-dashboard)).

**Milestone M3**: sign in with any OpenID Connect provider, boards as metadata
(optimistic locking), **real-time collaboration** over a WebSocket (module `collab`, section
[Collaboration](#collaboration)), **folders, trash, sharing** (users, groups, links), **guests** without an account and
**versions** of a board (sections [Folders, trash and versions](#folders-trash-and-versions),
[Sharing](#sharing-members-groups-and-links), [Guests](#guests)) - and, new in M3, **files** (images, video, PDF,
Office documents, served through signed URLs, converted to PDF by Gotenberg) and **plugins** (installed by upload,
sandboxed on the client, with their own asset server and storage): sections [Files](#files) and [Plugins](#plugins).

## Modules

```
core ──implementation──► shared
  └──runtimeOnly──► api, auditing, users, library, collab, files, plugins, planning
api ──► users, library, collab, files, plugins, planning, shared   (never core, never auditing)
auditing, users, library, collab, files, plugins, planning ──► shared   (domain modules never know each other)
```

Every module lives in `modules/<name>`; project paths stay `:core`, `:api`, …

| Module | Contents | Schema |
|---|---|---|
| `core` | `DrawboardApplication`, the **route table** and token validation (`core/infra/security`), request id, OTel wiring, Flyway per module, clock, R2DBC converters. Only module with the Boot plugin | – |
| `api` | controllers implementing the generated `BoardsApi`/`FoldersApi`/`SharingApi`/`UsersApi`/`CollabApi`/`FilesApi`/`FileContentApi`/`PluginsApi`/`PlanningApi`; `*ApiService` translate contract ↔ domain and orchestrate `users` + `library` + `collab` + `files` + `plugins` + `planning` (`SignedInUsers`); the WebSocket endpoint (handshake, bridge); the plugin asset server; RFC 9457 errors | – |
| `shared` | toolbox in flat topic packages: errors (`ErrorCode` mirrors the contract 1:1), the ports `CurrentUserProvider`/`AuditTrail`/`AppLogger`, paging, `@WithSpan`, Kotlin type converters | – |
| `auditing` | append-only audit trail (enforced in code, no triggers) | `auditing` |
| `users` | `UserProfile`: our own UUIDv7 per (issuer, subject); sync at login | `users` |
| `library` | boards, folders, trash, grants (user/group/link), share links, the `AccessResolver` that turns a caller into a role | `library` |
| `collab` | real-time collaboration: one-time tickets, rooms (the sessions of an open board), update log, snapshots, compaction, awareness relay, `drawboard.v1` frame codec | `collab` |
| `files` | uploads of a board: type detection (Apache Tika core), caps and quotas, storage port (filesystem adapter), thumbnails, signed URLs, ranges, Gotenberg conversion (port + adapter), orphan sweep | `files` |
| `plugins` | plugin registry: ZIP rules, manifest schema, grants, upgrades, the enabled list with pseudonyms, the frame document, the storage per plugin and board | `plugins` |
| `planning` | planning poker: rounds on story cards, participants (members and guests), votes, the result of a reveal, caps, rates, pruning | `planning` |

`files`, `plugins` and `planning` do not know boards, roles or tokens: `api` checks the role on the board first (`FilesApiService`,
`PluginsApiService`, `PlanningApiService`) and then calls the use case. `library` does not know `users` (house rule): the `*ApiService` looks the caller up through
the users use case and hands `library` the user's own id. Likewise `collab` does not know `library`:
it asks two ports (`BoardAccess.roleOf`, `BoardActivity.contentChanged`) that `api` implements on top
of the library use cases. Package layout inside a module
(`common`, `domain/<sub>/{model,provides,requires/impl}`, `infra`) and the rules (ArchUnit
in `core`, Gradle guard in `build-logic`) are those of the house skill `spring-kotlin`.

## Security: a generic OIDC resource server

No Keycloak library, no Keycloak-specific claim anywhere: a deployment binds **any** OpenID
Connect provider (Keycloak, Authelia, Entra ID, Zitadel …) by environment variables.

| Variable | Meaning | Default |
|---|---|---|
| `OIDC_ISSUER_URI` | **required**; must equal the token's `iss` byte for byte | – |
| `OIDC_AUDIENCE` | **required, startup fails if empty**; `aud` of every token must contain it | – |
| `OIDC_JWK_SET_URI` | optional: URL of the signing keys when the backend reaches the provider under another address than the browser; otherwise found through `/.well-known/openid-configuration` | – |
| `OIDC_CLAIM_USERNAME` | claim with the user name | `preferred_username` |
| `OIDC_CLAIM_GROUPS` | claim with the groups; a dot path walks into objects (`resource_access.drawboard-api.roles`) | `groups` |
| `DRAWBOARD_ADMIN_GROUP` | a user is instance admin when the groups of the **current token** contain exactly this value; **empty = nobody is admin** | empty |
| `OIDC_WEB_CLIENT_ID` | public client Swagger UI signs in with (dev only) | `drawboard-web` |

What the backend enforces on every token:

* signature, with the algorithms **RS256, ES256, PS256 only** (never `none`, never HS*); the
  key set is re-read when a token names an unknown `kid`;
* `iss` equals `OIDC_ISSUER_URI` exactly, `aud` contains `OIDC_AUDIENCE`, `exp`/`nbf` with a
  clock skew of 60 seconds (Spring's default);
* identity is **(`iss`, `sub`)** and nothing else - never `preferred_username` or `email`; our own
  user id is a UUIDv7 assigned at the first login (`users.user_profile`, unique on issuer + subject);
* `email` is only stored when the token says `email_verified=true`;
* **admin** is computed per request from the current token's groups (exact match). It is never
  stored or cached, and admin does **not** grant access to anybody's boards. The effective
  configuration is logged once at startup. The stored `groups` are display-only.

**Provider requirements** (otherwise every login ends in 401):

* **Keycloak** needs an *audience mapper* on the client that mints the token (client →
  Client scopes → dedicated scope → *Audience*, included client audience `drawboard-api`), and a
  *group membership* mapper (full path off) for the `groups` claim. The dev realm has both.
* **Authelia** issues opaque access tokens unless the client sets
  `access_token_signed_response_alg: RS256`; set it, and put `OIDC_AUDIENCE` in the client's
  `audience`.

Route table (`SecurityConfig`): one line per contract operation, all `signedIn` (a user of the OIDC
provider, **not a guest**) except the few that guests may also call (`signedInOrGuest`, the allowlist of
S1.8), the link exchange (anonymous visitors, `notGuest`) and the guest-only refresh; the one other route,
the collaboration WebSocket, is `permitAll` because its one-time ticket authenticates it (see below); the
last rule is `denyAll` (a new route is unreachable until it is added). Strictly stateless: no session, no
cookie, no HTTP Basic, CSRF off (pure bearer API), **no CORS** on `/api` (the frontend calls it
same-origin through its proxy; the backend never answers `Access-Control-Allow-Origin`). The
actuator (`health`, `info` only) runs on its own management port.

Access to boards and folders (module `library`, `AccessResolver`): the one place that turns a caller
(signed-in user with the groups of the **current token**, or a guest) into a role - see
[Sharing](#sharing-members-groups-and-links). Whoever has no role gets `LIBRARY_BOARD_NOT_FOUND` /
`LIBRARY_FOLDER_NOT_FOUND` (404, never 403, so existence is not revealed); a role that is too weak gives
`LIBRARY_BOARD_ACCESS_DENIED` (403) / `FORBIDDEN`.

Proxies (S7.3): the backend does **not** enable `forward-headers-strategy`. The client address (rate
limits, audit, guest session cap) is the socket address; `X-Forwarded-For` counts **only** when the direct
peer is listed in `DRAWBOARD_TRUSTED_PROXIES` - then the rightmost entry that is not itself a trusted proxy
is the client. Empty (default) = nobody is trusted. In **compose** list the Docker network of the frontend
container (the nginx that forwards `/api`), e.g. `172.18.0.0/16` (`docker network inspect drawboard`); in
**Helm** the pod CIDR of the ingress controller. Without it every client looks like the proxy and the rate
limits count all users together; with a wrong (too wide) value a client could name its own address. Nothing
logs the `Authorization` header or `Sec-WebSocket-Protocol`: log fields are method, path, status and error
code only.

Secrets (database password, …) come only from environment variables (or `_FILE`/Docker secrets in
deployment); the values in `compose*.yaml`, `application-dev.yaml` and `dev/` are throwaway local
values. A deployment compose gives PostgreSQL no host port.

## Folders, trash and versions

Every user has a personal space: **folders** form a tree (`parent_id`), boards live in a folder or in the
root. Moving a board or a folder is an update with the optimistic lock `version` (409 `CONFLICT`);
moving a folder into itself or below itself is 409 `LIBRARY_FOLDER_CYCLE`.

**Trash (S7.7).** Deleting a board or folder is a soft delete: `deleted_at` is set on the item and, for a
folder, on everything below it **with the same instant** - that is how a restore finds what belonged to the
deletion (`listTrash` shows one entry per deletion). A restore goes back to the old folder or - when that is
in the trash or gone - to the root. Open sessions of trashed boards end with 4404. A job (`TrashCleanup`)
purges what is older than `DRAWBOARD_TRASH_RETENTION_DAYS` (default 30), checking every
`DRAWBOARD_TRASH_CLEANUP_SECONDS` (default 3600): boards, folders, grants and links first (library), then log
and snapshots (collab). Known gap: if the process dies between the two steps, the drawing data of a purged
board stays stored (nothing sweeps it yet).

**Versions (S2.8).** The kept snapshots of a board are its versions (`GET .../versions`, owner only).
Restoring one stores it as a **new base snapshot with a sequence number above everything that exists** (a
new epoch), drops the update log and audits "version restored"; after the commit every session of the board
is closed with **4410** "document replaced" **before** the restore writes (joins get 429 and retry until it is committed, so no update can land on the emptied log) (`docs/collab-protocol.md`); the next join gets the restored
drawing. The older versions stay listed until the normal retention removes them.

## Sharing: members, groups and links

* **Grants** (`library.grant_entry`): USER (own user id), GROUP (name; matched against the groups of the
  **current access token**, never stored groups - the collab ticket carries them, S6.5) or LINK_USER (a
  user who opened a link while signed in; ends with the link). A grant on a folder applies to everything
  below it, the **strongest role wins**, the owner is never a grant, `OWNER` is never granted. Only the owner
  changes grants (editors get 403, strangers 404). Every change is an audit event.
* **User search** (S6.9/6.10): prefix on username/display name, at least 2 characters, 20 hits, 30 per
  minute and user, never emails, `%`/`_` are literal. `DRAWBOARD_USER_SEARCH=off` answers an empty list.
* **Share links** (S1.1, S1.11, S1.12): the token is 256 bit from `SecureRandom`, shown **once** in the
  answer of the create call as `<DRAWBOARD_PUBLIC_URL>/s#<token>`; the database stores `sha256(token)`
  only. Optional Argon2 password (at least 8 characters, `Argon2PasswordEncoder` defaults of Spring Security
  7), optional expiry, roles editor/commenter/viewer, audience `SIGNED_IN` (default) or `GUESTS`. Opening a
  link (`POST /shares/exchange`): unknown, revoked, expired tokens and links to a trashed board answer the
  **same** 404; limits per client address: 10 invalid tokens per minute; 5 wrong passwords per minute per
  link, 20 per hour per link, then 429 with a **growing** `Retry-After` - the link is never locked for good.
  Besides these failure rules, **every** exchange or refresh attempt counts per client address (IPv6 by
  /64): at most `LIBRARY_EXCHANGES_PER_MINUTE` (30) whatever its outcome, and every password verification
  - correct ones too - at most `LIBRARY_PASSWORD_CHECKS_PER_MINUTE` (10) per link and address. A blocked attempt
  is counted by the metric (`result=rate_limited`) and audited **once per block window and key**, not once per
  request; real failures (unknown token, wrong password) are audited every time.
  Every success and failure is an audit event (link id, address; never token or password).

## Guests

Off by default (`DRAWBOARD_GUESTS_ENABLED=false`, S1.14); a `GUESTS` link cannot even be created then.
Switching it on needs the signing keys; the checklist of `../docs/architecture.md` ("Before enabling in
production") applies.

| Variable | Meaning | Default |
|---|---|---|
| `DRAWBOARD_GUESTS_ENABLED` | the ONE instance switch (read by the token signer and the API alike) for links for visitors without an account | `false` |
| `DRAWBOARD_GUEST_SIGNING_KEYS` | one or more **EC P-256 private keys, PKCS#8 PEM**; the first signs, all verify; `\n` may stand for newlines; startup fails when guests are on and none is given | – |
| `DRAWBOARD_GUEST_SIGNING_KEYS_FILE` | the same list in a file (Docker/Kubernetes secret); wins over the variable | – |
| `DRAWBOARD_TRUSTED_PROXIES` | CIDR list of the proxies whose `X-Forwarded-For` is believed | empty |
| `DRAWBOARD_USER_SEARCH` | `all` or `off` | `all` |
| `DRAWBOARD_TRASH_RETENTION_DAYS` / `_CLEANUP_SECONDS` | trash retention and job interval | `30` / `3600` |

Make a key: `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt`.
**Rotation:** put the new key first, remove the old one after 12 hours (the longest a guest session lives).

* The application signs its own tokens (**ES256**, `kid` = fingerprint of the public key): issuer
  `<DRAWBOARD_PUBLIC_URL>/guest` (startup fails if it equals `OIDC_ISSUER_URI`), header and claim `typ` =
  `guest`, `sub` = `guest:<random>`, `aud` = `OIDC_AUDIENCE`, `share`, `res` (`BOARD:<id>`/`FOLDER:<id>`),
  `role`, `name` (sanitised, at most 64 characters, never a registered user's name), `pw`, `auth_time`, `exp`
  (at most 15 minutes, never after the link, never later than 12 hours after `auth_time`), `jti`.
* The resource server has **two issuers from a fixed list** (the OIDC provider, and the application when guests
  are on), one decoder each, with an algorithm allowlist, exact `iss`, required `aud`, skew 60 s. The OIDC
  decoder refuses `typ = guest`; the guest decoder requires it.
* A guest is its own principal (`GuestAuthenticationToken`), never a `JwtAuthenticationToken`. **Allowlist**
  (S1.8): read the board (`GET /boards/{id}`), list the boards of a shared folder (`GET /boards?folderId=`),
  collab ticket + WebSocket, refresh, files and plugins read-only (M3 review), and - for links with the role `COMMENTER` or
  `EDITOR` only - planning poker: list (`state=OPEN` only), get and vote (M4 review, see [Planning poker](#planning-poker));
  everything else is 403. A guest reaches only the resource of its link and
  what lies below it (S1.7). Every request looks the link up again (cache of at most 30 s, S1.13):
  revocation, expiry, a trashed board end the guest's REST access (401/404) and its WebSocket (4403/4404).
* In the collaboration a guest is marked `guest: true`, never compacts, and at most 50 guest sessions per client
  address are open (S2.5).

## Collaboration

A board is one [Yjs](https://yjs.dev) document. The backend never reads it: it stores and relays
Yjs updates as opaque bytes and numbers them (`seq`, no gaps). The protocol `drawboard.v1` (frames,
roles, compaction, limits, close codes) is specified in
[`docs/collab-protocol.md`](../api/docs/collab-protocol.md) of the API repository; the security
decisions behind it are S2.1-S2.12 and S7.1-S7.3 in [`../docs/architecture.md`](../docs/architecture.md).

| Part | What it does |
|---|---|
| `POST /api/boards/{id}/collab-ticket` | 256 bit one-time ticket, valid 30 s, bound to user, board and the token's `exp`; 60 per minute and user (Bucket4j), then `429` with `Retry-After` |
| `GET /api/boards/{id}/collab` (WebSocket) | handshake checked **before** the upgrade: subprotocols `drawboard.v1` + exactly one `ticket.<t>` (else 400), `Origin` equals `DRAWBOARD_PUBLIC_URL` (else 403), ticket redeemed (else 401), role resolved again (none: 404), session limits (429). Frames up to 1 MiB, no `permessage-deflate` |
| `PUT /api/boards/{id}/snapshot?upToSeq=N` | the answer to `COMPACT(N)`: one open request per board, to one signed-in editor, valid 2 minutes; checked **before** the body is read: `429` with `Retry-After` above 10 attempts per minute and user, `409 COLLAB_SNAPSHOT_NOT_REQUESTED` unless such a request is open (it is consumed after the read); then at most 50 MB (read as a stream, cut off with `413`). An upload that would push the board's kept snapshots over their budget (`COLLAB_SNAPSHOT_BUDGET_BYTES`) is a `413` |
| session lifecycle | ends at the token's `exp` (4401), after 5 minutes without a message (4408), when the role is gone (4403; re-checked every minute through the port, a changed role sends `ROLE`), when the board is deleted (4404) |
| storage | tables `collab.board_update` (the log) and `collab.board_snapshot`; after each snapshot the last 5 snapshots **or** all of the last 7 days are kept (whichever is more), bounded by a byte budget per board (500 MiB; the newest 5 are always kept), and the log up to the oldest kept snapshot is dropped. Log and snapshots have separate limits (log: `COLLAB_MAX_LOG_BYTES`, snapshots: `COLLAB_SNAPSHOT_BUDGET_BYTES`). A board is asked for a compaction at most once a minute |

**One replica.** Tickets, rooms and the sequence numbers live in the memory of the process: `seq` is
assigned under a per-room lock and appended to the log in that order, so two replicas would hand out
the same `seq` for one board (the unique key `(board_id, seq)` would reject one of them). More than
one replica needs the PostgreSQL `LISTEN/NOTIFY` fan-out of S2.12 first - until then the deployment
runs the backend with one replica. A restart closes all sessions (1001); clients reconnect with backoff
and nothing is lost: every accepted update is in the log before it is acknowledged.

Configuration (environment variables, relaxed binding of the `collab.*` properties, defaults from the
protocol document; sizes in bytes, times in seconds):

| Variable | Meaning | Default |
|---|---|---|
| `DRAWBOARD_PUBLIC_URL` | **required, startup fails if empty or not an origin**: scheme `http`/`https`, host, optional port (`:443`/`:80` are dropped, as browsers do in `Origin`), no path, query, fragment or user info (one trailing slash is ignored), e.g. `https://drawboard.example.org`; a handshake is accepted only with exactly this `Origin` (dev profile: `http://localhost:4200`) | – |
| `COLLAB_MAX_UPDATE_BYTES` / `COLLAB_MAX_AWARENESS_BYTES` | largest `UPDATE` / `AWARENESS` frame (1009 above) | 1048576 / 16384 |
| `COLLAB_UPDATES_PER_SECOND` / `COLLAB_UPDATE_BURST` | per session; sustained excess closes with 4429 | 60 / 200 |
| `COLLAB_AWARENESS_PER_SECOND` / `COLLAB_AWARENESS_BURST` | per session | 30 / 60 |
| `COLLAB_MAX_SESSIONS_PER_USER` / `COLLAB_MAX_SESSIONS_PER_BOARD` | the handshake answers 429 above | 20 / 200 |
| `COLLAB_MAX_LOG_BYTES` | size of a board's update log; above it updates are rejected and the sender is closed with 4413 (kept snapshots do not count, they have their own budget) | 104857600 |
| `COLLAB_MAX_SNAPSHOT_BYTES` | snapshot upload (also `spring.webflux.multipart.max-disk-usage-per-part` in `application.yaml`) | 52428800 |
| `COLLAB_COMPACTION_BYTES` / `COLLAB_COMPACTION_ENTRIES` | log since the last snapshot that triggers `COMPACT` (more than) | 1048576 / 500 |
| `COLLAB_COMPACTION_REQUEST_SECONDS` / `COLLAB_COMPACTION_MIN_INTERVAL_SECONDS` | how long a `COMPACT` request stays open / least time between two requests of a board | 120 / 60 |
| `COLLAB_SNAPSHOT_BUDGET_BYTES` | bytes of all kept snapshots of one board; older ones go first, the newest `COLLAB_SNAPSHOTS_KEPT` always stay; an upload above it is a 413 | 524288000 |
| `COLLAB_SNAPSHOT_UPLOADS_PER_MINUTE` | snapshot uploads a user may start per minute (`429` with `Retry-After` above) | 10 |
| `COLLAB_IDLE_TIMEOUT_SECONDS` / `COLLAB_ACL_RECHECK_SECONDS` | idle close (4408) / role re-check | 300 / 60 |
| `COLLAB_SNAPSHOTS_KEPT` / `COLLAB_SNAPSHOTS_KEPT_DAYS` | retention: the last N snapshots or all of the last D days | 5 / 7 |
| `COLLAB_TICKET_SECONDS` / `COLLAB_TICKETS_PER_MINUTE` | ticket lifetime / issue limit per user | 30 / 60 |
| `COLLAB_OUTBOUND_BUFFER` / `COLLAB_OUTBOUND_BYTES` | frames / bytes queued per session; a client that cannot keep up is closed with 1011 (a single frame always fits an empty buffer) | 1024 / 16777216 |

A display name in the sender (`From`) of a frame is cut to 64 characters.

Behind a reverse proxy the WebSocket needs the `Upgrade` headers passed on and read/send timeouts above
the 30 s ping interval (S7.9). Nothing logs `Sec-WebSocket-Protocol` (it carries the ticket) or a ticket.

Metrics (OTLP, no user, board or ticket in any label): gauges `drawboard.collab.sessions`,
`drawboard.collab.rooms`, `drawboard.boards`, `drawboard.storage.bytes{kind=snapshot|log}` (read every
5 minutes; alert on it, S2.7); counters `drawboard.collab.updates`, `drawboard.collab.update.bytes`,
`drawboard.collab.dropped{reason=role|awareness}`, `drawboard.collab.closes{code}` (the close code, or
`client`), `drawboard.collab.compactions{result=requested|stored|rejected|expired}`. Audit: a stored snapshot
is `collab.snapshot.stored` (who, `upToSeq`, size, what the retention removed), next to the existing
board created/deleted and first-login events.

## Build and test

```bash
./gradlew build                # unit tests, controller slices, ArchUnit (no Docker)
./gradlew integrationTest      # whole app against PostgreSQL 18 (Testcontainers)
```

The contract `at.dergeorg.drawboard:drawboard-api-kotlin` comes from the package registry of the
GitLab group `apps/drawboard` (numeric id 147 in `settings.gradle.kts`); its version is
`drawboard-api` in `gradle/libs.versions.toml`. Locally Gradle needs
`gitlabPrivateToken=<personal access token, scope read_api>` in `~/.gradle/gradle.properties`.
For a contract built locally (`scripts/build.sh install` in the API repository) add
`-PuseMavenLocal=true` and set the version to `0.0.1-SNAPSHOT` - never push that.

detekt (as in the pipeline, all ten modules; rule set `at.dergeorg.ci:detekt-rules:1.1.0`):

```bash
mkdir -p .lint-tools
curl -fsSLo .lint-tools/detekt.jar https://github.com/detekt/detekt/releases/download/v1.23.8/detekt-cli-1.23.8-all.jar
# detekt-rules.jar: package registry of ci/detekt-rules (project 75), needs a GitLab token
java -jar .lint-tools/detekt.jar \
  --input modules/core/src,modules/api/src,modules/shared/src,modules/auditing/src,modules/users/src,modules/library/src,modules/collab/src,modules/files/src,modules/plugins/src,modules/planning/src \
  --config config/detekt.yml --build-upon-default-config --plugins .lint-tools/detekt-rules.jar
```

Test conventions: `kotlin.test` with a message on every assertion, names ``when … then …``,
`@Nested inner class`, test packages by domain, one PostgreSQL Testcontainer per test JVM.
`RouteTableIntegrationTest` covers every contract operation (401 anonymous, not 401/403 when
signed in); `CollabIntegrationTest` runs the collaboration end to end (really signed tokens, a real
WebSocket client, PostgreSQL); `OidcTokenIntegrationTest` sends really signed tokens (wrong audience, wrong issuer,
expired, foreign key, HS256, `alg: none` → 401); `FilesIntegrationTest`, `FileServingIntegrationTest`,
`FileConversionIntegrationTest` (against a FAKE Gotenberg, never the real image), `FileUrlLeakIntegrationTest`,
`UploadGuardIntegrationTest` (411/413/429 before the body, the spool directory stays empty) and
`PluginsIntegrationTest` cover M3; `PlanningIntegrationTest` (every rule of the planning poker contract, members and guests),
`MetricsIntegrationTest` (the usage metrics as registered), `FileScannerIntegrationTest` and `FileScannerFailClosedIntegrationTest`
(against a fake clamd) cover M4. The test PostgreSQL runs with `max_connections=400`: every cached application context
keeps a connection pool.

## Files

Module `files` (S4), contract tag `files` and `file-content`. A file belongs to exactly one board; **who may see the board
may see its files** (guests of its link too, without `createdBy`); upload and delete need the role `EDITOR` or `OWNER` and a
signed-in user - **never a guest** (S1.9). The bytes are never served under `/api`.

| Route | |
|---|---|
| `POST /api/boards/{id}/files` (multipart `file`) | streamed with a **hard byte cap whatever `Content-Length` says** (50 MB; video 500 MB), the type **detected from the content** with Apache Tika's magic-byte detector against the allowlist png, jpeg, gif, webp, mp4, webm, pdf, Office Open XML, OpenDocument (SVG never; the extension must match; the stored name is the UUID, the client's name only sanitised in the database). `415 FILES_TYPE_NOT_ALLOWED`, `413 PAYLOAD_TOO_LARGE` / `FILES_QUOTA_EXCEEDED` (user, board, at most 500 files per board; the quotas count originals **and converted PDFs**), `429` (30 uploads and a byte budget per user and minute; 10 conversions per user and minute). Nothing is stored when a check fails. An image with more than 50 megapixels in its header is refused before it is decoded (`400`, field `file`) |
| `GET /api/boards/{id}/files`, `…/{fileId}`, `…/urls?ids=` | metadata, and **signed URLs** (`/files/{id}?v=original\|thumbnail\|pdf&exp=&sig=`, HMAC-SHA256 over `fileId\|v\|exp`, at most one hour). The answer is `Cache-Control: no-store` |
| `DELETE /api/boards/{id}/files/{fileId}` | the file with every variant; audited |
| `GET /files/{fileId}?v=&exp=&sig=` | **no token, `permitAll` for GET only**: the signature authorises. Order: 400 (malformed) → **one** 403 `FILES_URL_INVALID` for every verification failure (wrong signature, expired, `exp` more than an hour + 60 s ahead, unknown variant, retired key; constant-time compare against every key) → 404 only for a valid signature. Headers: `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, max-age=3600`, `Cross-Origin-Resource-Policy`, `Content-Disposition` (inline only for images and videos, RFC 5987 file name). **One** byte range per request (`206`, or `416` with `Content-Range: bytes */size`). The query string is never logged and never in a span |

* **Images** (png, jpeg, gif): a thumbnail of at most 512 px is made on upload - dimensions read from the header first, decoded
  subsampled in a bounded pool of its own with a timeout, re-encoded without metadata. The decoder reads the stored file itself,
  through a channel in pieces of at most 64 KiB (the original never sits in the heap whole), and read plus decode holds one of
  `FILES_DECODE_THREADS` permits until the decode really ends. A **progressive JPEG** (frame header SOF2/6/10/14) above 16
  megapixels is stored but gets **no thumbnail** (libjpeg holds ~6 bytes a pixel for it, natively), like WebP (size from the
  header, no thumbnail: the JDK has no WebP decoder). JPEG originals lose EXIF, XMP, IPTC, comments and every APP2 that is not an
  ICC profile (the multi-picture block of a camera JPEG can carry EXIF previews); only the orientation tag is kept. "Nothing to
  strip" is only the answer of a walk over the header segments that reached the start of the scan; a header that cannot be walked
  (damaged, cut off, more than 4 MB of segments) is refused with `400 VALIDATION_FAILED` on field `file`, never guessed at.
* **Office documents** are converted to PDF asynchronously by **Gotenberg** (`DRAWBOARD_GOTENBERG_URL`): `conversion`
  goes `PENDING` → `DONE`/`FAILED`, clients poll `getFile`. One conversion at a time per instance (queue), 60 s timeout, the
  result must start with `%PDF-` and is size-capped, only `POST /forms/libreoffice/convert` is called, with a file name made
  from the *detected* type. Drawboard never unpacks an Office file itself (the ZIP type is told from the entry names). The
  original is always downloadable, as an attachment. **Without `DRAWBOARD_GOTENBERG_URL` a document is stored with
  `conversion: FAILED`.** A full conversion queue (100) marks the file `FAILED` too (audit reason `QUEUE_FULL`, also after a restart). In the compose files Gotenberg runs on an `internal: true` network that only the backend joins,
  non-root, read-only, with `--chromium-disable-routes=true` and a memory limit.
* **What Gotenberg can reach.** The `conversion` network is `internal: true` (no route out), but the backend is on it too, so a
  process inside the Gotenberg container (LibreOffice opening a hostile document is the realistic way in) can open
  connections to `drawboard-backend:8080` and `:8081`. That is harmless by construction: the API answers `401` without a token
  (every operation is in the route table, the rest is `denyAll`), `/files/{id}` needs a valid HMAC signature (one `403` for
  everything else), `/plugin-assets/` serves what is public anyway, the link exchange needs a valid link token and is rate
  limited per address, and the actuator on `:8081` exposes `health` and `info` only, without details. There is no secret on
  any of these routes and no state a token-less call can change. **Check by hand once on dev** (and after changing the
  network or the route table), from inside the container (`docker exec <gotenberg> sh`; the image has `curl`):

  ```bash
  curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://drawboard-backend:8080/api/users/me      # 401
  curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://drawboard-backend:8080/api/admin/plugins # 401
  curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://drawboard-backend:8080/files/x           # 400 or 403, never 200
  curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://drawboard-backend:8081/actuator/env       # 404
  curl -s -m 5 http://drawboard-backend:8081/actuator/health                                      # {"status":"UP"}, no details
  curl -s -m 5 https://example.org                                                               # fails: no route out
  ```

  Anything but those answers is a finding. The same applies to unraid (the network is named `drawboard-conversion` there).
* **Malware scan** (S4.12, optional): every upload is scanned **before the file becomes visible** - right after the bytes are
  stored and before anything parses them - by the port `FileScanner`. Without `DRAWBOARD_CLAMAV_HOST` the adapter does nothing
  (and the file is not even opened for it). With it, the ClamAV adapter speaks the clamd protocol `zINSTREAM` over TCP: the
  stored original is streamed in chunks of 64 KiB, with a connect timeout and a timeout for the whole scan (a watchdog closes the
  socket), and a file larger than `DRAWBOARD_CLAMAV_MAX_BYTES` (default 25 MiB, clamd's own `StreamMaxLength`) is not sent at all.
  *Infected*: `415 FILES_TYPE_NOT_ALLOWED` (the contract has no code of its own; the signature is **not** in the answer), nothing is
  stored, audit event `files.file.rejected` with the signature, the SHA-256 and the reason `INFECTED`. *Could not be scanned*
  (clamd down, too slow, an error answer, the stored blob not openable): `DRAWBOARD_CLAMAV_FAIL_CLOSED=false` (default) accepts
  the upload, `true` refuses it with `503 INTERNAL_ERROR` and a `Retry-After` of 30 seconds (the contract has no code of its own for
  it; logged at WARN without a stack trace) - either way it is counted (`drawboard.scans{result="unavailable"}`), so a scanner that
  is down is visible in Grafana, and an alert fires on it. A file *larger than the scanner takes* is not a scanner failure: with
  fail closed it is `413 PAYLOAD_TOO_LARGE` with `params.limit` = `DRAWBOARD_CLAMAV_MAX_BYTES`, with fail open it is accepted;
  it is counted as `drawboard.scans{result="too_large"}`, not as `unavailable`.
  **With fail closed, `DRAWBOARD_CLAMAV_MAX_BYTES` and clamd's `StreamMaxLength`, `MaxFileSize` and `MaxScanSize` (clamd.conf)
  must each be at least `files.max-video-bytes` (default 500 MiB)**, otherwise no video can be uploaded; the backend logs a WARN at
  start when it is configured to fail closed with `DRAWBOARD_CLAMAV_MAX_BYTES` below the video cap (it cannot see clamd's own
  limits - a clamd that is lower answers with an error, which is `503` under fail closed). The PDFs Gotenberg makes are not scanned again (the original was). The security
  review wants the scanner on before guests or third-party plugins may upload.

  | Environment | |
  |---|---|
  | `DRAWBOARD_CLAMAV_HOST` / `_PORT` | the clamd to use (`3310`); empty host = no scan |
  | `DRAWBOARD_CLAMAV_MAX_BYTES` | largest file sent to clamd (default `26214400`); keep it equal to clamd's `StreamMaxLength`, and at least the video cap with fail closed |
  | `DRAWBOARD_CLAMAV_TIMEOUT_SECONDS` | the whole scan (default `60`); the connect timeout is `files.clamav-connect-timeout-seconds` (3) |
  | `DRAWBOARD_CLAMAV_FAIL_CLOSED` | `true` refuses an upload that could not be scanned (default `false`) |

* **Storage** is a port; the adapter keeps `<DRAWBOARD_FILES_DIR>/<first two digits>/<uuid>[.thumbnail|.pdf]`, written to a
  temp file and moved atomically. An S3 adapter implements the same port later.
* **Trash and purge** (S7.7, S4.13): files follow their board into the trash and are removed (rows and bytes) with the
  hard delete - by hand (`DELETE /api/trash/…`), by folder and by the cleanup job. A daily sweep deletes stored blobs
  that have no metadata row and are older than 24 hours.
* **Audit** (S7.1): `files.file.created` (name, type, size, SHA-256 of the received bytes), `files.file.deleted`, `files.file.rejected` (the scan found something),
  `files.file.converted` (result and a reason *code* - never a message of the converter). Never a URL.
* **Uploads** are described in the next section: Spring writes a multipart part to a temp file *before* a handler runs, so
  the upload guard decides from the headers first.

### Uploads: what happens before the body is read

Three routes take a multipart body: `POST /api/boards/{id}/files`, `PUT /api/boards/{id}/snapshot`, `POST /api/admin/plugins`.
Spring's multipart reader spools a part to a temp file while the handler's argument is resolved - after every `WebFilter` and
before any check of the handler. `UploadGuardWebFilter` (core, order right behind Spring Security) therefore decides from the
**request headers**, for exactly these three routes, and answers without reading the body:

| Check | Answer |
|---|---|
| no `Content-Length`, or any `Transfer-Encoding` (chunked) | `411` (code `MALFORMED_REQUEST`, the contract has no code of its own for it) |
| `Content-Length` above the cap of the route plus 1 MiB multipart envelope: files `FILES_MAX_VIDEO_BYTES` (500 MB), snapshot `COLLAB_MAX_SNAPSHOT_BYTES` (50 MiB), plugin 20 MiB | `413 PAYLOAD_TOO_LARGE` with the cap of the route as `limit` |
| more than `FILES_UPLOADS_PER_MINUTE` (30) uploads started per user and route in a minute | `429`, `Retry-After` |
| more than 2 uploads of the same user in flight (all three routes together), or more than 8 in the instance | `429`, `Retry-After` |

* It runs **after authentication and the route table**: a stranger gets `401`, a non-admin on `/api/admin/plugins` `403`,
  never `413`/`411`. The slot of an upload in flight is released when the response is done - completed, failed or cancelled
  (the client hung up).
* The 30/min counters here are the guard's own; the service of the files module keeps its own counter (second line, per user
  id). A request is counted once in each, never twice in one.
* Browsers send `Content-Length` for `FormData` and `Blob` bodies, and the frontend's nginx (`proxy_request_buffering off`)
  forwards it as it came, so 411 does not meet a normal client. A client that streams a multipart body without knowing its length
  gets 411 and has to buffer it first. Tests build their bodies with a length (`multipartForm`).
* `spring.webflux.multipart.max-parts` is `1`: every multipart form of the contract has exactly one part.
* **Spool directory** `DRAWBOARD_UPLOAD_SPOOL_DIR` (default: the JVM's temp directory, where Spring spooled before). It is created
  and checked for writing at the start, and temp files an earlier run left behind are removed (nothing is in flight yet). In the
  compose files it is `/tmp/spool` on the container's `tmp` volume - a disk-backed volume, not a tmpfs (S2.8) - and that volume
  is bounded by arithmetic, not by a quota (the local volume driver has none): at most `app.uploads.global-concurrent` (8)
  parts are spooled at once, each at most 500 MB + 1 MiB, i.e. **4 GiB at worst**, whoever uploads and however often; one user
  holds at most 2 places. Keep 5 GB free on the disk behind the volume (dev: Docker's data directory on note; prod: the
  docker.img / cache pool of unraid) and, where a filesystem quota is available, put one on it. The files volume
  (`/data/files`) is a different one, so a full spool cannot fill the place the files live.

| Environment | |
|---|---|
| `DRAWBOARD_FILES_DIR` | **required**: the directory (volume) the files are stored in |
| `DRAWBOARD_FILE_URL_KEYS` / `_FILE` | **required**: the signing keys, comma or line separated, each base64 of at least 32 random bytes; the first signs, all verify (rotation: new key first, old key out after an hour). The `_FILE` variant wins and is the one for secrets (S7.8) |
| `DRAWBOARD_GOTENBERG_URL` | the Gotenberg sidecar, e.g. `http://gotenberg:3000`; empty = no conversion |
| `DRAWBOARD_FILES_ORIGIN` | set when files are served from an origin of their own: `Cross-Origin-Resource-Policy: same-site` |
| `DRAWBOARD_UPLOAD_SPOOL_DIR` | where multipart uploads are spooled before the handler runs; default the JVM temp directory; compose: `/tmp/spool` (see above) |
| `APP_UPLOADS_PER_USER_CONCURRENT`, `APP_UPLOADS_GLOBAL_CONCURRENT`, `APP_UPLOADS_PER_USER_PER_MINUTE`, `APP_UPLOADS_ENVELOPE_BYTES`, `APP_UPLOADS_MAX_PLUGIN_BYTES` | the upload guard (defaults 2, 8, `FILES_UPLOADS_PER_MINUTE` = 30, 1 MiB, 20 MiB); the caps of files and snapshots follow `FILES_MAX_VIDEO_BYTES` and `COLLAB_MAX_SNAPSHOT_BYTES` |
| `FILES_MAX_FILE_BYTES`, `FILES_MAX_VIDEO_BYTES`, `FILES_MAX_BYTES_PER_USER`, `FILES_MAX_BYTES_PER_BOARD`, `FILES_MAX_FILES_PER_BOARD`, `FILES_UPLOADS_PER_MINUTE`, `FILES_UPLOAD_BYTES_PER_MINUTE`, `FILES_CONVERSIONS_PER_MINUTE`, `FILES_CONVERSION_TIMEOUT_SECONDS`, `FILES_CONVERSION_QUEUE`, `FILES_DECODE_THREADS`, `FILES_DECODE_TIMEOUT_SECONDS`, `FILES_ORPHAN_GRACE_SECONDS`, `FILES_SWEEP_INTERVAL_SECONDS` | limits (defaults: 50 MB, 500 MB, 5 GiB, 2 GiB, 500, 30, 1 GiB, 10, 60, 100, 2, 10, 24 h, 24 h) |

**What the frontend's nginx has to do** (not part of this repository): `client_max_body_size 500m` on
`/api/boards/*/files` and 21m on `/api/admin/plugins`; proxy `/files/` and `/plugin-assets/` to the backend
(`proxy_buffering off` and `proxy_request_buffering off` for uploads; pass `Range`, `Accept-Ranges` and `Content-Range`
through); `limit_conn` on `/files/` (S4.4); **no query string in the access log of `/files/`** (S7.2); do not add its own
`X-Frame-Options` to `/plugin-assets/` (the generated frame document says who may embed it with `frame-ancestors`);
do not add `Content-Security-Policy` or cache headers to `/files/` and `/plugin-assets/`; `frame-src`
of the app's CSP must name the plugin origin, `img-src`/`media-src`/`connect-src` the files origin (S7.5).

## Plugins

Module `plugins` (S3), contract tag `plugins`; manifest, package rules and the host ↔ plugin protocol are in
`docs/plugin-protocol.md` of the API repository.

| Route | |
|---|---|
| `GET/POST /api/admin/plugins`, `GET/PUT/DELETE /api/admin/plugins/{id}` | **instance admins only**, decided in the route table by the groups claim of the *current* token (S6.6) - everyone else 403, anonymous 401, guests 403. Install by ZIP upload only |
| `GET /api/plugins` | every signed-in user **and guest**: the enabled plugins with asset base, entry, `integrity`, block types, granted capabilities and `userPseudonym` |
| `GET/PUT /api/boards/{id}/plugin-storage/{pluginId}` | the key-value object (≤ 1 MB, optimistic `version`); read: any role (guests too), write: `EDITOR`/`OWNER`, signed in, **at most 60 writes per user and board per minute** (`429`, `Retry-After`; `PLUGINS_STORAGE_WRITES_PER_MINUTE`). The plugin must be enabled (404) and have `storage` granted (403) |
| `GET /plugin-assets/<id>/<version>/<sha256>/<path>` | no token, GET only: the files of an enabled plugin's current bundle |

* **Install** (S3.9): ≤ 20 MB (413); the ZIP is read in memory, **nothing is extracted to a file system**; ≤ 200 entries and
  ≤ 50 MB unpacked, *counted while unpacking*; paths must be `[A-Za-z0-9._/-]`, relative, without `..`, `.`, empty segments,
  duplicates (case-insensitive) or the reserved prefix `__drawboard`; symbolic links are refused; only `.js .mjs .css
  .json .png .jpg .jpeg .gif .webp .woff2 .txt .md` (no HTML, SVG or WebAssembly). Then `drawboard-plugin.json` against its
  schema and the rules the schema cannot say (block types in the namespace of the `id`, `core.*` and `drawboard.*`
  reserved, `network` hosts: https only, two or more labels, not `local lan internal localhost home arpa`, no IP
  literals or wildcards, at most 10). `400 PLUGINS_ARCHIVE_INVALID` (reason, path) or `PLUGINS_MANIFEST_INVALID`
  (a violation per problem, field = JSON path).
* **Registry**: a new id is installed *disabled with nothing granted*. A higher version (semver precedence) upgrades:
  the files go to a new asset base, `enabled` is kept, and only grants equal in name **and** value are kept; the same or a
  lower version is `409 PLUGINS_VERSION_EXISTS`. `updatePlugin` sets `enabled` and the complete set of grants with the
  `revision` it is based on (`409 CONFLICT` otherwise); a grant the installed version does not request is
  `400 PLUGINS_CAPABILITY_NOT_REQUESTED`. Removing deletes files and the storage on every board.
* **Integrity** (S3.6): `bundleSha256` is in the asset path, the SHA-384 of the ZIP is shown to the admin and audited, and the
  SRI value of the entry module goes into the generated frame document and the enabled list.
* **Assets** (S3.5): looked up in the *stored entry list* by exact path (a database row per file, no file system), only for
  the current bundle of an *enabled* plugin; `Cache-Control: public, max-age=31536000, immutable`, `nosniff`, and the
  one place with `Access-Control-Allow-Origin: *` - never with credentials. `__drawboard/frame.html` is **generated**, never a
  file of the ZIP: the module script with its `integrity`, and the CSP `sandbox allow-scripts; default-src 'none';
  script-src|style-src|img-src|font-src <origin><assetBase>; connect-src <granted hosts or 'none'>; base-uri 'none';
  form-action 'none'; frame-ancestors <app origin>` (never `'self'`, no WebAssembly); `no-cache` because it carries the
  current grants. This is the only response without `X-Frame-Options: DENY` (see `FrameOptionsWebFilter`): exactly `/plugin-assets/<id>/<version>/<sha256>/__drawboard/frame.html`, the bundle's scripts, styles and images get `DENY`.
* **Pseudonyms** (S3.8): `base64url(HMAC-SHA256(DRAWBOARD_PLUGIN_PSEUDONYM_KEY, userId|pluginId))` - the user id of a
  signed-in user or the guest's id. A secret of its own: **the application does not start if it equals one of the keys in `DRAWBOARD_FILE_URL_KEYS`** (checked in core on the decoded keys, also from the `_FILE` secrets).
* **Audit** (S7.1): `plugins.plugin.created`/`updated` (installed or upgraded, with both hashes and the requested
  capabilities), `…enabled`, `…disabled`, `…grants-changed`, `…deleted`. The installer is the actor.

| Environment | |
|---|---|
| `DRAWBOARD_PLUGIN_PSEUDONYM_KEY` / `_FILE` | **required**: base64 of at least 32 random bytes |
| `DRAWBOARD_PLUGIN_ORIGIN` | optional own origin of the assets (S3.4); `assetBase` is then a URL on it and the CSP sources too. Deployed as a second host name of the frontend's nginx container (same value as its `PLUGIN_ORIGIN`), which serves only `/plugin-assets/` there and refuses it on the app host |
| `PLUGINS_INSTALLS_PER_MINUTE` | uploads per admin and minute (default 10, S7.3) |
| `PLUGINS_STORAGE_WRITES_PER_MINUTE` | storage writes per user and board and minute (default 60) |

**Third-party plugins** stay off in production until the checklist "Before enabling in production" of the security
decisions is done (S3.4, the main-app CSP, Playwright negative tests of the sandbox).

## Planning poker

Module `planning` (S7.6), contract tag `planning` (contract 2.0.0), decisions in "M4 contract review: planning poker" of
`../docs/architecture.md`. A facilitator starts a round on a **story card**, the participants vote, the facilitator reveals.
A **quick round** has no story card (`storyBlockId` absent, column `story_block_id` NULL since migration `V2`): its result is
only shown, written nowhere; several may be open at once, and they count towards the 10 `OPEN` rounds per board.
Rounds, participants and votes live **only on the server** - never in the Yjs document, where every client of the board could read
them - and the server **never reads or writes the document either**: after `revealPokerRound` the facilitator's client writes the
estimate into the story card (`estimate`) and clears its `pokerRoundId`; any editor can do it later from the revealed round.
`storyBlockId` and `pokerRoundId` are untrusted hints: the server checks the id format only.

| Route | Who |
|---|---|
| `GET /api/boards/{id}/poker-rounds[?state=]` | any role; guests with a `COMMENTER`/`EDITOR` link, `state=OPEN` only. Newest first, at most 50; 30 per user and board and minute |
| `POST /api/boards/{id}/poker-rounds` | `EDITOR`/`OWNER`, signed in. At most one `OPEN` round per story card (`409 PLANNING_ROUND_ALREADY_OPEN`, `params.roundId`; not for quick rounds) and 10 per board, quick rounds included (`PLANNING_ROUND_LIMIT_REACHED`); 10 per user and minute |
| `GET /api/boards/{id}/poker-rounds/{roundId}` | any role, guests as above. **Joins** a member with `COMMENTER` or higher on the first fetch of an `OPEN` round; a guest joins only by voting; a full round never fails a get. `ETag: W/"<version>"`, `If-None-Match` → `304` (a `*` or a stale tag → `200`), `Cache-Control: no-store`, `Vary: Authorization`; 60 per user and round and minute (a 304 counts) |
| `PUT …/{roundId}/vote` | `COMMENTER` or higher, guests with a `COMMENTER`/`EDITOR` link. A value of the deck (`400 PLANNING_VALUE_INVALID`, the value is never echoed); `409 PLANNING_ROUND_CLOSED`; 30 per user and round and minute |
| `POST …/{roundId}/reveal`, `…/cancel` | the facilitator while still `EDITOR`/`OWNER`, or the `OWNER` of the board; never guests; final (`409 PLANNING_ROUND_CLOSED` for a closed round); no rate limit |

* **Version / ETag**: rises when a participant joins, votes for the first time, the round is revealed or cancelled, or guests are
  removed because their link was revoked. A changed vote does **not** raise it (nobody else may notice it), so a client keeps its
  own vote from the 204. Clients poll every 2 s while the dialog is open and stop when the round is no longer `OPEN`.
* **Votes** are secret until the reveal - from members, from the facilitator, in the audit trail and in the logs. The reveal
  computes the result from the votes (average and median of the numeric deck values rounded to two decimals, the distribution in
  deck order, the suggestion = most chosen estimate ignoring `?` and `coffee`, the higher on a tie). A cancel deletes the votes
  at once. A zero-vote reveal is allowed.
* **Decks**: `FIBONACCI` (`0 1 2 3 5 8 13 21 ? coffee`), `TSHIRT` (`XS S M L XL ?`) or `CUSTOM` (2-20 values of 1-8 characters,
  no leading or trailing whitespace, no control or format characters (Unicode Cc/Cf), distinct after NFC normalisation). The same
  Cc/Cf rule applies to the title (1-200 characters, trimmed).
* **Caps**: 200 participants per round, of them at most 50 guests and 20 per share link; a non-participant who votes in a full
  round gets `409 PLANNING_ROUND_FULL` (`params.limit` = the cap that was hit). A board keeps at most 500 closed rounds: a create
  first prunes the oldest `CANCELLED`, then the oldest `REVEALED` rounds with their votes.
* **Guests** (S1.8, M4 review): only links with the role `COMMENTER` or `EDITOR` (a `VIEWER` link: `403` on every operation), only
  the board of the link or boards below its folder; a guest never sees `facilitatorId`, never the history of the board (a `REVEALED`
  or `CANCELLED` round only as its participant, else `404 PLANNING_ROUND_NOT_FOUND`); its identity is the `sub` of the guest
  session (a new exchange of the link is a new participant, shown with `guest: true`); limits are also keyed by share (300 gets and
  300 lists, 100 votes per share, round or board and minute). **Revoking the link removes its guests and their votes from every
  `OPEN` round at once** (`SharingApiService.revokeLink` → `PlanningUseCase.removeGuestsOfShare`).
* **Names** are the display names as they were when the participant joined (members keep seeing people who left the board); a user
  who no longer exists reads `Deleted user`. No user id of a participant is ever sent (only the facilitator's, to members).
* **Trash**: rounds follow their board into the trash (`404` while it is there) and are deleted with their votes by the purge
  (`BoardDataEraser`: by hand, by folder, by the cleanup job).
* **Audit** (S7.1): `planning.round.created` (board, story block, facilitator), `planning.round.revealed` (actor and the number of
  member and guest votes), `planning.round.cancelled`. Never a vote, never a join.
* **Metrics**: `drawboard.planning.rounds{event=started|revealed|cancelled}`, `drawboard.planning.votes`,
  `drawboard.planning.refused{reason=rate_limit|round_full}`.
* **Lists** return at most 20 rounds for `state=OPEN` (a board holds at most 10 open ones by default) and at most 50 for the closed
  states, which is the contract's `maxItems`; participants are read only for the rounds the caller may see.
* **Revocation is also checked at the reveal**: `removeGuestsOfShare` runs after the revoke committed, and if it fails the revoke
  still answers `204` and the failure is logged at `ERROR` with the share id (`SharingApiService.revokeLink`). As a safety net the
  reveal asks `library` (through the port `GuestShares`, implemented in `api` by `LibraryGuestShares`) which of the guests' links are
  gone and deletes those guests with their votes before it builds the result.
* Concurrency: the writes to one round (and the creates on one board) run one after the other in this process - one replica, like
  every other counter of the application.
* **Before a second replica** (review finding 7, not built): the caps and the per-round order hold per process (`KeyedLocks` and the
  rate limiters are in memory), so with two replicas two requests can pass the same cap at the same time. The two integrity
  invariants are backed by the database's unique keys (one `OPEN` round per story card; one participant per round, kind and
  principal), so they hold anyway: a lost race is refused instead of corrupting the data. Before running more than one replica, take the row lock
  `SELECT … FOR UPDATE` on the round (and the board's rounds for a create) inside the transaction, and move the rate limits to a shared store.

| Environment (all optional, for tests of a cap) | Default |
|---|---|
| `PLANNING_MAX_PARTICIPANTS` / `_MAX_GUESTS` / `_MAX_GUESTS_PER_SHARE` | `200` / `50` / `20` |
| `PLANNING_MAX_OPEN_ROUNDS` / `_MAX_CLOSED_ROUNDS` | `10` / `500` |
| `PLANNING_CREATES_PER_MINUTE` / `_LISTS_PER_MINUTE` / `_GETS_PER_MINUTE` / `_VOTES_PER_MINUTE` | `10` / `30` / `60` / `30` |
| `PLANNING_SHARE_LISTS_PER_MINUTE` / `_SHARE_GETS_PER_MINUTE` / `_SHARE_VOTES_PER_MINUTE` | `300` / `300` / `100` |

## Metrics and the dashboard

Everything is pushed by OTLP to Alloy and Prometheus (nothing is exposed for scraping). Names are Micrometer names; Prometheus
shows dots as underscores and appends `_total` to counters (`drawboard.uploads` → `drawboard_uploads_total`). A gauge that needs the
database is read every five minutes (a scrape never blocks on R2DBC), so it is a flat line between two readings. No label carries a
user, a board, a file name or a vote.

| Metric (architecture 3.11) | Type | Labels | State |
|---|---|---|---|
| `drawboard.boards` | gauge | – | existed (no owner type: every board belongs to a user) |
| `drawboard.users.active` | gauge | `window` = `24h` `7d` `30d` | **new** (users who signed in within the window) |
| `drawboard.collab.sessions`, `drawboard.collab.rooms` | gauge | – | existed |
| `drawboard.collab.updates` | counter | – | existed |
| `drawboard.collab.update.bytes` | histogram | – | **now a histogram** (count, sum, buckets; was a counter) |
| `drawboard.collab.dropped` / `.closes` / `.compactions` | counter | `reason` / `code` / `result` | existed |
| `drawboard.storage.bytes` | gauge | `kind` = `snapshot` `log` `files` | `files` **new** |
| `drawboard.uploads`, `drawboard.conversions` | counter | `result` | **new** |
| `drawboard.scans` | counter | `result` = `clean` `infected` `too_large` `unavailable` | **new** (S4.12) |
| `drawboard.share.links.active` | gauge | `audience` | existed as `drawboard.shares` (renamed, and it was never registered - fixed) |
| `drawboard.guest.sessions` | counter | – | existed (sessions started or renewed; the token is stateless, so "open now" is unknown) |
| `drawboard.share.exchanges` | counter | `result` | existed |
| `drawboard.planning.rounds` / `.votes` / `.refused` | counter | `event` / – / `reason` | **new** |
| `drawboard_blocks` by type | – | – | **not built**: the server never reads the Yjs document, so there are no board summaries |
| `drawboard_exports_total`, `drawboard_imports_total` | – | – | **not built**: export and import run in the browser (S5.5, S5.6); the frontend can report them through Faro |

Plus the standard HTTP, JVM and R2DBC metrics, traces and logs.

**Dashboard "17 · Drawboard usage"** (uid `svc-drawboard`, folder Services) shows all of the above in six rows: who and what,
collaboration, storage and files, sharing and guests, planning poker. It is generated with the others:

```bash
python3 dev/observability/grafana/gen_service_dashboards.py dev/observability/grafana/provisioning/dashboards/services
python3 dev/scripts/check_panels.py --service drawboard-backend --env dev   # every query against a running stack
```

The JSON is `dev/observability/grafana/provisioning/dashboards/services/17-drawboard.json`; see [dev/README.md](dev/README.md)
for the stack. In the homelab the generator moves to `monitoring/grafana/gen_service_dashboards.py` as described in the
monitoring skill.

## Local

Infrastructure (PostgreSQL 18 on :15432, Keycloak 26.7.4 on :18180) and the optional
observability stack: [dev/README.md](dev/README.md).

```bash
docker compose up -d
./gradlew bootRun                         # profile dev: API :18081, management :18082, Swagger UI /swagger-ui.html
curl -s -H "Authorization: Bearer $(dev/scripts/token.sh alice)" localhost:18081/api/users/me
curl -s localhost:18082/actuator/health
```

The dev profile stores files under `./data/files` (git-ignored) and brings throwaway keys for the file URLs and the plugin
pseudonyms; without `DRAWBOARD_GOTENBERG_URL` documents are stored but not converted. Never port 8080 on the Mac. Guest checks need a key:
`DRAWBOARD_GUESTS_ENABLED=true DRAWBOARD_GUEST_SIGNING_KEYS="$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt)" ./gradlew bootRun`. Other variables: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `APP_ENVIRONMENT`, `DRAWBOARD_PUBLIC_URL` (outside the dev profile).

## Pipeline

`.gitlab-ci.yml` is the house pipeline renamed for drawboard (version, lint, unit + integration tests,
jar, image, SBOM, release); there is deliberately no Dockerfile (the pipeline builds the image).
Commit messages follow Conventional Commits - they determine the version.

## Deploy

| | dev | prod |
|---|---|---|
| Where | Portainer stack `drawboard-backend-dev` on note (endpoint 3) | Portainer stack `drawboard-backend` on unraid (endpoint 4) |
| Compose | `deploy/note/docker-compose.dev.yml` | `deploy/unraid/docker-compose.yml` |
| Public URL (through the frontend) | https://drawboard-dev.dergeorg.at | https://draw.dergeorg.at |
| Rolled out | every push to `main` (`deploy:dev`) | click on `deploy:prod`, only after asking Georg |
| Data | named volumes (throwaway) | `/srv/drawboard/postgres` and `…/files` (owned by uid 10001) |

Both stacks are Portainer **Git stacks** of these files on `main` (created by
`gitlab-devops/scripts/24-drawboard-stacks.sh`); Portainer picks up changes every 5 minutes, the
pipeline only sets `APP_IMAGE`. `DB_PASSWORD` lives only in the stack environment; the two **file secrets**
`file_url_keys`, `plugin_pseudonym_key` and `guest_signing_keys` are files in the host directory `SECRETS_DIR` (stack environment variable;
owned by uid 10001, mode 0400, outside every repository, S7.8). Each
stack contains PostgreSQL 18 (no host port), **Gotenberg** (`gotenberg/gotenberg:8.40.0`, on its own `internal: true` network
that only the backend joins) and the backend (no host port, read-only root file
system, non-root, no capabilities); it creates the network `drawboard-dev` / `drawboard` that the
frontend stack joins to reach `http://drawboard-backend:8080`.

Fixed networks and trusted proxies (S7.3): the backend stack creates the network `drawboard-dev` with the
subnet `10.231.90.0/24` (prod: `drawboard`, `172.31.251.0/24`; on note `172.16.0.0/12` is taken by Docker's /16 defaults); the frontend stack joins it as external.
`DRAWBOARD_TRUSTED_PROXIES` lists that subnet (the frontend's nginx) and NPM (`192.0.2.4/32`). On note NPM
reaches the frontend over the LAN, so the hop the frontend sees is `192.0.2.4`. On unraid NPM and the stacks share
the host: if NPM reaches the frontend through the host's port mapping, the source address the frontend's nginx
sees may be the Docker bridge gateway (`172.17.0.1`) instead of `192.0.2.4` - then the real client address is
lost behind that hop and every client counts as one. **Verify once after each change:** open any link in the app
through the public URL (or `curl https://draw.dergeorg.at/api/shares/exchange` with a made-up well-formed token),
then look at the audit event `library.share.exchange-failed` (field `ip`): it must show your real public
address. If it shows `172.17.0.1` or an address of the stack network, add that address of the missing hop to
`DRAWBOARD_TRUSTED_PROXIES` and make the proxy chain send `X-Forwarded-For` (NPM and the frontend's nginx must
append it, e.g. `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`). Guest links are on in both
stacks (stack variable `GUESTS_ENABLED=true`, key `guest_signing_keys` in `SECRETS_DIR`); switching them off is
`GUESTS_ENABLED=false` and a redeploy of the stack.

Sign-in: Authelia (`https://sso.dergeorg.at`, audience `drawboard-api`) until the central Keycloak
exists - then only `OIDC_ISSUER_URI` changes.
