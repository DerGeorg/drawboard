# drawboard-api

The contract (OpenAPI 3.1) of Drawboard, a self-hosted collaborative whiteboard — API-first: the
interface is described here first, and from it come the Kotlin interfaces for
the [backend](../backend) and the Angular client for the
[frontend](../frontend). Neither of them writes routes or DTOs by hand.

Backend, frontend and API live in **separate repositories within one group**:
they are versioned independently but belong together.

## Layout

```
openapi.yaml                  root: info, tags, servers, security, path table -> api/api.yaml
api/
  api.yaml                    ALL operations (paths), one comment block per resource:
                              boards + trash (module library, subdomain boards), folders (module
                              library, subdomain folders), sharing (module library, subdomain
                              sharing: members, links, exchange, shared with me), collab
                              (module collab), files + file-content (module files),
                              plugins (module plugins), planning (module planning,
                              subdomains rounds and sessions), users (module users)
common/
  common.yaml                 ALL components - every key under components.schemas = exactly one model:
                              schemas    ErrorModel, FieldViolation, ErrorCode | PageInfo |
                                         Board, BoardRole, NewBoard, BoardUpdate, BoardMove, BoardPage |
                                         Folder, NewFolder, FolderUpdate, FolderList |
                                         SharedWithMe, Trash |
                                         GrantRole, MemberPrincipalKind, MemberPrincipal, Member,
                                         MemberList, MemberUpdate |
                                         ShareAudience, ShareLink, ShareLinkList, NewShareLink,
                                         CreatedShareLink | ShareResourceKind, ShareExchange,
                                         ShareAccess, GuestSession, ShareRefresh |
                                         CollabTicket, BoardSnapshotUpload (multipart form),
                                         BoardVersion, BoardVersionList |
                                         BoardFile, BoardFileKind, BoardFileConversion, BoardFileList,
                                         FileUpload (multipart form), FileContent (binary alias),
                                         FileUrl, FileUrlList |
                                         Plugin, PluginBlockType, PluginCapabilityName,
                                         PluginCapability, PluginList, PluginUpload (multipart form),
                                         PluginUpdate, EnabledPlugin, EnabledPluginList,
                                         PluginStorage, PluginStorageUpdate |
                                         PokerDeckKind, PokerDeck, PokerRoundState, NewPokerRound,
                                         PokerRound, PokerParticipant, PokerResult, PokerResultVote,
                                         PokerValueCount, PokerVote, PokerRoundList |
                                         EstimationMode, EstimationSessionState,
                                         EstimationItemRefKind, EstimationItemRef, NewEstimationItem,
                                         EstimationSettings, NewEstimationSession,
                                         EstimationSessionMe, EstimationSessionSummary,
                                         EstimationSessionList, EstimationSession, EstimationSeat,
                                         EstimationItem, EstimationItemResult, EstimationEntry,
                                         EstimationStart, EstimationPlacement, RotationEstimate,
                                         EstimationAdvance, EstimationDecision |
                                         CurrentUser, UserSummary, UserSummaryList
                              parameters PageNumber, PageSize, BoardId, BoardFolderFilter,
                                         ParentFolderFilter, FolderId, UserId, GroupName, LinkId,
                                         VersionId, UserSearchQuery, UpToSeq, FileId, FileIds,
                                         FileVariant, FileUrlExpiry, FileUrlSignature, ByteRange,
                                         PluginId, PokerRoundId, PokerRoundStateFilter,
                                         EstimationSessionId, EstimationItemId,
                                         EstimationSessionStateFilter, IfNoneMatch
                              headers    File* (response headers of downloadFile, S4.5),
                                         PokerRoundETag, EstimationSessionETag, NoStoreCacheControl,
                                         VaryAuthorization (getPokerRound, getEstimationSession)
                              responses  BadRequest, Unauthorized, Forbidden, NotFound, NotAcceptable,
                                         Conflict, PayloadTooLarge, UnsupportedMediaType,
                                         RangeNotSatisfiable, TooManyRequests, InternalError
docs/
  collab-protocol.md          the WebSocket protocol drawboard.v1 (OpenAPI cannot describe it),
                              including close code 4410 (version restored)
  plugin-protocol.md          plugin API 1.0.0: package rules, manifest drawboard-plugin.json
                              (with JSON Schema), sandboxed frame loading, the host <-> plugin
                              MessageChannel protocol per capability, limits, error replies
redocly.yaml                  lint rules
contract.env                  coordinates, package, stack, npm name, Keycloak issuer, tool versions
scripts/
  build.sh                    lint → bundle → breaking → generate → check → jar / npm package
                              (copied unchanged from ci/components examples/contract-build.sh)
  check-generated-models.mjs  check after generating (see Rules)
oasdiff-severity.txt          severity overrides for oasdiff (no comment lines!)
oasdiff-ignore.txt            individual formal breaks without a change in behavior (see Versioning)
renovate.json                 Renovate reads the tool versions in contract.env
.gitlab-ci.yml                pipeline (component openapi in script mode, see below)
```

**One file per folder.** `api/` holds exactly `api/api.yaml`, `common/` exactly
`common/common.yaml`. IntelliJ's OpenAPI preview only renders files that are an
OpenAPI document themselves, so both are complete OpenAPI 3.1 documents
(`openapi: 3.1.0`, `info` with `version: 0.0.0`, then `paths` resp.
`components`) - open either one in IntelliJ and the preview shows it.
`openapi.yaml` references every path into `api/api.yaml` (JSON pointer, `/` as
`~1`):

```yaml
paths:
  /boards:
    $ref: 'api/api.yaml#/paths/~1boards'
  /boards/{boardId}:
    $ref: 'api/api.yaml#/paths/~1boards~1{boardId}'
```

(`paths: {$ref: 'api/api.yaml#/paths'}` in one line is accepted by Redocly but
is not valid OpenAPI - the Paths object has no `$ref`.) References from
`api/api.yaml` go to `../common/common.yaml#/components/schemas/<Name>`
(`…/parameters/<Name>`, `…/responses/<Name>`); inside `common/common.yaml`
they are local: `'#/components/schemas/Board'`.

Routes (milestones M0-M4): boards, folders, trash, sharing (members, links,
guests), collaboration ticket, snapshots and versions, files (M3), plugins
(M3), planning poker (M4), estimation sessions (Magic Estimation, Rotation), users. The drawing itself is synchronised over the collaboration
WebSocket (`docs/collab-protocol.md`); the plugin sandbox protocol is
`docs/plugin-protocol.md`. "Role" is the caller's role on the board or
folder; **G** = also open to guests (S1.8, limited to the board or folder of
their link and what lies below it).

| Operation | Tag | Role needed | Errors besides 400/401/500 |
|---|---|---|---|
| `listBoards` `GET /boards[?folderId=]` | boards | – (root of own space) / `VIEWER` on the folder; **G** with `folderId` | 403, 404, 406 |
| `createBoard` `POST /boards` | boards | – (own folder) | 403, 404, 406, 415 |
| `getBoard` `GET /boards/{boardId}` | boards | `VIEWER`; **G** | 404, 406 |
| `updateBoard` `PUT /boards/{boardId}` | boards | `EDITOR` | 403, 404, 406, **409**, 415 |
| `deleteBoard` `DELETE /boards/{boardId}` | boards | `OWNER` (to the trash) | 403, 404 |
| `moveBoard` `PUT /boards/{boardId}/folder` | boards | `OWNER` | 403, 404, 406, **409**, 415 |
| `listTrash` `GET /trash` | boards | – (own trash) | 403, 406 |
| `restoreBoard` `POST /trash/boards/{boardId}/restore` | boards | `OWNER` | 403, 404, 406 |
| `purgeBoard` `DELETE /trash/boards/{boardId}` | boards | `OWNER` | 403, 404 |
| `listFolders` `GET /folders[?parentId=]` | folders | – (own) / `VIEWER` on the parent | 403, 404, 406 |
| `createFolder` `POST /folders` | folders | – (own parent) | 403, 404, 406, 415 |
| `getFolder` `GET /folders/{folderId}` | folders | `VIEWER` | 403, 404, 406 |
| `updateFolder` `PUT /folders/{folderId}` | folders | `OWNER` | 403, 404, 406, **409** (version, cycle), 415 |
| `deleteFolder` `DELETE /folders/{folderId}` | folders | `OWNER` (to the trash) | 403, 404 |
| `restoreFolder` `POST /trash/folders/{folderId}/restore` | folders | `OWNER` | 403, 404, 406 |
| `purgeFolder` `DELETE /trash/folders/{folderId}` | folders | `OWNER` | 403, 404 |
| `listSharedWithMe` `GET /boards/shared` | sharing | – | 403, 406 |
| `listBoardMembers` `GET /boards/{boardId}/members` | sharing | `VIEWER` | 403, 404, 406 |
| `setBoardUserMember` `PUT /boards/{boardId}/members/users/{userId}` | sharing | `OWNER` | 403, 404, 406, 415 |
| `removeBoardUserMember` `DELETE /boards/{boardId}/members/users/{userId}` | sharing | `OWNER` | 403, 404 |
| `setBoardGroupMember` `PUT /boards/{boardId}/members/groups/{group}` | sharing | `OWNER` | 403, 404, 406, 415 |
| `removeBoardGroupMember` `DELETE /boards/{boardId}/members/groups/{group}` | sharing | `OWNER` | 403, 404 |
| `listFolderMembers`, `setFolderUserMember`, `removeFolderUserMember`, `setFolderGroupMember`, `removeFolderGroupMember` (`/folders/{folderId}/members/...`) | sharing | as for boards | as for boards |
| `listBoardShareLinks` `GET /boards/{boardId}/links` | sharing | `OWNER` | 403, 404, 406 |
| `createBoardShareLink` `POST /boards/{boardId}/links` | sharing | `OWNER` | 403, 404, 406, 415 |
| `listFolderShareLinks`, `createFolderShareLink` (`/folders/{folderId}/links`) | sharing | `OWNER` | as for boards |
| `revokeShareLink` `DELETE /links/{linkId}` | sharing | `OWNER` | 403, 404 |
| `exchangeShareToken` `POST /shares/exchange` | sharing | – (**anonymous allowed**) | 401, 403, 404, 406, 415, 429 |
| `refreshGuestSession` `POST /shares/refresh` | sharing | guests only; **G** | 403, 404, 406, 415, 429 |
| `createCollabTicket` `POST /boards/{boardId}/collab-ticket` | collab | `VIEWER`; **G** | 404, 406, 429 |
| `uploadBoardSnapshot` `PUT /boards/{boardId}/snapshot` | collab | `EDITOR` (signed in) | 403, 404, 409, 413, 415, 429 |
| `listBoardVersions` `GET /boards/{boardId}/versions` | collab | `OWNER` | 403, 404, 406 |
| `restoreBoardVersion` `POST /boards/{boardId}/versions/{versionId}/restore` | collab | `OWNER` | 403, 404 |
| `listFiles` `GET /boards/{boardId}/files` | files | `VIEWER`; **G** | 403, 404, 406 |
| `uploadFile` `POST /boards/{boardId}/files` (multipart) | files | `EDITOR` (signed in, never guests) | 403, 404, 406, 413, 415, 429 |
| `getFileUrls` `GET /boards/{boardId}/files/urls?ids=` | files | `VIEWER`; **G** | 403, 404, 406 |
| `getFile` `GET /boards/{boardId}/files/{fileId}` | files | `VIEWER`; **G** | 403, 404, 406 |
| `deleteFile` `DELETE /boards/{boardId}/files/{fileId}` | files | `EDITOR` (signed in) | 403, 404 |
| `downloadFile` `GET /files/{fileId}?v=&exp=&sig=` (**outside /api**) | file-content | – (**no token**, the signed URL authorises) | 400, 403, 404, 416 (no 401) |
| `listPlugins` `GET /admin/plugins` | plugins | instance admin | 403, 406 |
| `installPlugin` `POST /admin/plugins` (multipart) | plugins | instance admin | 403, 406, 409, 413, 415, 429 |
| `getPlugin` `GET /admin/plugins/{pluginId}` | plugins | instance admin | 403, 404, 406 |
| `updatePlugin` `PUT /admin/plugins/{pluginId}` | plugins | instance admin | 403, 404, 406, **409**, 415 |
| `removePlugin` `DELETE /admin/plugins/{pluginId}` | plugins | instance admin | 403, 404 |
| `listEnabledPlugins` `GET /plugins` | plugins | –; **G** | 403, 406 |
| `getPluginStorage` `GET /boards/{boardId}/plugin-storage/{pluginId}` | plugins | `VIEWER`; **G** | 403, 404, 406 |
| `putPluginStorage` `PUT /boards/{boardId}/plugin-storage/{pluginId}` | plugins | `EDITOR` (signed in) | 403, 404, 406, **409**, 413, 415 |
| `listPokerRounds` `GET /boards/{boardId}/poker-rounds[?state=]` | planning | `VIEWER`; **G** (`COMMENTER`/`EDITOR` link, `state=OPEN` only) | 403, 404, 406, 429 |
| `createPokerRound` `POST /boards/{boardId}/poker-rounds` | planning | `EDITOR` (signed in, never guests) | 403, 404, 406, **409**, 415, 429 |
| `getPokerRound` `GET /boards/{boardId}/poker-rounds/{roundId}` (`If-None-Match` → **304**) | planning | `VIEWER`; **G** (`COMMENTER`/`EDITOR` link; closed rounds only as participant) | 403, 404, 406, 429 |
| `castPokerVote` `PUT /boards/{boardId}/poker-rounds/{roundId}/vote` | planning | `COMMENTER`; **G** (`COMMENTER`/`EDITOR` link) | 403, 404, **409** (closed, full), 415, 429 |
| `revealPokerRound` `POST /boards/{boardId}/poker-rounds/{roundId}/reveal` | planning | facilitator (still `EDITOR`) or `OWNER` | 403, 404, 406, **409** |
| `cancelPokerRound` `POST /boards/{boardId}/poker-rounds/{roundId}/cancel` | planning | facilitator (still `EDITOR`) or `OWNER` | 403, 404, 406, **409** |
| `listEstimationSessions` `GET /boards/{boardId}/estimation-sessions[?state=ACTIVE\|CLOSED]` | planning | `VIEWER`; **G** (`COMMENTER`/`EDITOR` link, `state=ACTIVE` only) | 403, 404, 406, 429 |
| `createEstimationSession` `POST /boards/{boardId}/estimation-sessions` | planning | `EDITOR` (signed in, never guests) | 403, 404, 406, **409**, 415, 429 |
| `getEstimationSession` `GET /boards/{boardId}/estimation-sessions/{sessionId}` (`If-None-Match` → **304**) | planning | `VIEWER`; **G** (`COMMENTER`/`EDITOR` link; REVIEW, DONE, CANCELLED only with a seat) | 403, 404, 406, 429 |
| `joinEstimationSession` `PUT /boards/{boardId}/estimation-sessions/{sessionId}/seats/me` | planning | `COMMENTER`; **G** (`COMMENTER`/`EDITOR` link) | 403, 404, **409** (state, full), 429 |
| `leaveEstimationSession` `DELETE /boards/{boardId}/estimation-sessions/{sessionId}/seats/me` | planning | `COMMENTER`; **G** (`COMMENTER`/`EDITOR` link) | 403, 404, **409**, 429 |
| `startEstimationSession` `POST /boards/{boardId}/estimation-sessions/{sessionId}/start` | planning | moderator (creator, still `EDITOR`) or `OWNER` | 403, 404, 406, **409**, 415, 429 |
| `placeEstimationItem` `PUT /boards/{boardId}/estimation-sessions/{sessionId}/items/{itemId}/placement` | planning | seated, `COMMENTER`; **G** (`COMMENTER`/`EDITOR` link) | 403, 404, **409** (state, not held, move limit), 415, 429 |
| `setRotationEstimate` `PUT /boards/{boardId}/estimation-sessions/{sessionId}/items/{itemId}/estimate` | planning | seated holder, `COMMENTER`; **G** (`COMMENTER`/`EDITOR` link) | 403, 404, 406, **409** (state, not held), 415, 429 |
| `advanceEstimationSession` `POST /boards/{boardId}/estimation-sessions/{sessionId}/advance` | planning | moderator or `OWNER` | 403, 404, 406, **409**, 415, 429 |
| `decideEstimationItem` `PUT /boards/{boardId}/estimation-sessions/{sessionId}/items/{itemId}/decision` | planning | moderator or `OWNER` | 403, 404, **409**, 415, 429 |
| `finishEstimationSession` `POST /boards/{boardId}/estimation-sessions/{sessionId}/finish` | planning | moderator or `OWNER` | 403, 404, 406, **409**, 429 |
| `cancelEstimationSession` `POST /boards/{boardId}/estimation-sessions/{sessionId}/cancel` | planning | moderator or `OWNER` | 403, 404, 406, **409**, 429 |
| `getCurrentUser` `GET /users/me` | users | – | 403, 406 |
| `searchUsers` `GET /users/search?q=` | users | – (signed in, never guests) | 403, 406, 429 |

A board or folder the caller may not see answers 404
(`LIBRARY_BOARD_NOT_FOUND`, `LIBRARY_FOLDER_NOT_FOUND`), never 403, so its
existence is not revealed.

**Folders and sharing.** Every user has a personal space: folders form a tree,
boards live in a folder or in the root. Grants (user, group, link) on a
folder apply to everything below it; the strongest role wins. Only the owner
manages folders, members and links; `OWNER` can never be granted. Group
grants match the groups of the caller's *current* access token (S6.5). No
email address appears anywhere in the sharing API (S6.9).

**Trash (behaviour change in M2).** `deleteBoard` and `deleteFolder` move to
the trash (soft delete) instead of deleting at once; the wire format of
`deleteBoard` is unchanged. Restorable for 30 days, then purged.

**Share links and guests (S1).** The link token is created by the server and
appears **only** in the answer of `create*ShareLink` (`CreatedShareLink.url`,
`<public URL>/s#<token>`); the server stores its hash. Opening a link is
`exchangeShareToken`: signed-in callers get the link's role remembered,
anonymous callers on a `GUESTS` link get a 15-minute guest token
(`GuestSession`), renewed with `refreshGuestSession`. Unknown, revoked and
expired tokens answer the same 404 `LIBRARY_SHARE_NOT_FOUND`.

**Files (M3, S4).** A file belongs to one board; access = board access.
Uploads are signed-in editors only (never guests); the type is detected from
the content against an allowlist (no SVG), 50 MB (video 500 MB) plus quotas.
Office documents are converted to PDF asynchronously: `conversion` goes
`PENDING` → `DONE`/`FAILED`, clients poll `getFile` (no push in M3). The bytes
are never served under `/api`: `getFileUrls` issues signed URLs
`/files/{fileId}?v=<original|thumbnail|pdf>&exp=<unix>&sig=<hmac>` valid ≤ 1 h
(format at `FileUrl`), and `downloadFile` serves them with the S4.5 headers
and single range requests. `downloadFile` is in the contract with an
operation-level `servers: [{url: /}]` and `security: []`. **The generators
ignore operation-level `servers`:** the generated `FileContentApi` (own tag
`file-content`, so it stays apart from the `/api` interfaces) carries the
class-level `@RequestMapping("${api.base-path:/api}")` like every interface,
and the Angular `FileContentService` prefixes its `basePath`. The backend
maps the route to `/files/{fileId}` itself (e.g. its controller declares its
own type-level `@RequestMapping("")`, which wins over the interface's, or a
hand-written route using `FileContentApi.PATH_DOWNLOAD_FILE`); the frontend
never calls `downloadFile`, it puts the signed URLs into `src` attributes.

**Plugins (M3, S3).** Instance admins (`CurrentUser.admin`) install plugins
by uploading a ZIP, grant capabilities and enable them under
`/admin/plugins`; `listEnabledPlugins` gives every board host (guests too)
what it needs to load them in a sandboxed iframe. The plugin's own storage is
reached only through the host (`get/putPluginStorage`), never from the
plugin frame. Manifest, package rules and the MessageChannel protocol:
`docs/plugin-protocol.md`. Plugin assets (`/plugin-assets/<id>/<version>/<sha256>/`)
are static files outside `/api`, described at `Plugin.assetBase`, not as an
operation.

**Planning poker (M4, S7.6).** An editor starts a round on a story card
(`storyBlockId` = the block's id in the Yjs document; at most one `OPEN`
round per card, 10 per board) or a quick round without a card (no
`storyBlockId`; several may be open, they count towards the 10; the result
is only shown, written nowhere) with a deck (`FIBONACCI`, `TSHIRT` or 2-20
`CUSTOM` values). Members with `COMMENTER` or higher vote over REST; votes
live **only on the server**, never in the Yjs document, and nobody sees a
value before the reveal (`participants` only says who voted, without user
ids). The facilitator (or the board's owner) reveals or cancels; the reveal
is final and returns `result` (votes, average/median of the numeric values,
distribution, suggestion). The server never writes the document: the
facilitator's client writes the estimate into the story card. Live state
without a WebSocket change: clients poll `getPokerRound` every 2 s while the
dialog is open with `If-None-Match` (ETag `W/"<version>"`, 304 when
unchanged, `Cache-Control: no-store`, `Vary: Authorization`), at most 60
calls per user and round and minute; `version` rises on join, first vote,
reveal and cancel, not on a changed vote. A round holds at most 200
participants, 50 of them guests and 20 per share link (409
`PLANNING_ROUND_FULL` on `castPokerVote`; `getPokerRound` then shows the
round without adding the caller). Guests (S1.8, security review
2026-11-10): guests whose link role is `COMMENTER` or `EDITOR` may list
`OPEN` rounds, read open rounds (closed ones only if their guest session took
part) and vote; they join only by voting, identified by the guest session's
`sub`, with extra limits per share. VIEWER-link guests get 403 on every poker
operation; no guest creates, reveals or cancels. Revoking a link removes its
guest participants from `OPEN` rounds. A board keeps at most 500 closed
rounds (oldest cancelled, then oldest revealed are pruned); rounds and votes
are deleted with the board's hard delete.

**Optimistic locking.** `Board.version` and `Folder.version` increase with
every change of the metadata. A client that updates sends the version it read
in `BoardUpdate.version`, `BoardMove.version` or `FolderUpdate.version`; if it
is no longer current, the server changes nothing and responds 409 `CONFLICT`
— read again, try again.

**Title.** `NewBoard.title` and `BoardUpdate.title`: 1–200 characters and at
least one non-whitespace character (`pattern: '^\s*\S[\s\S]*'` — deliberately
written so that it means the same unanchored per JSON Schema/ECMA and anchored
per Java's `@Pattern`). The server trims leading and trailing whitespace.

## Rules

**Only the bundle counts.** `openapi.yaml` is never used directly.
`redocly bundle` resolves all file references into **one** file
(`build/openapi/openapi.yaml`) and lifts every schema under its key into
`components/schemas`. Generators, oasdiff and Swagger UI only see this bundle.
Fed the file tree directly, openapi-generator invents names like
`ListBoards200Response` or `CreateBoardRequest`.

**Every model exactly once, with a readable name.** Every key under
`components.schemas` in `common/common.yaml` becomes exactly one Kotlin `data class`/`enum class` and
exactly one TypeScript type with exactly that name. Nothing else is generated:
no `Board1`, no `InlineObject`, no `*200Response`/`*400Response`, no
`*Request`, no `*Inner`, no nested enum (`Board.Role`, `BoardRoleEnum`).
Enforced in two stages:

1. `redocly.yaml` (before generating):
   - every request/response body is a `$ref` to `common/common.yaml#/components/schemas/<Name>` — no inline schemas and no own `components` in `api/api.yaml`;
   - every parameter is a `$ref` to `common/common.yaml#/components/parameters/<Name>`, and parameter schemas are primitive (no object, no enum);
   - no `format: date` (rule `no-date-format`): times are `format: date-time` → `kotlin.time.Instant`; a calendar day is the instant it starts, with the time zone in the description.
2. `scripts/check-generated-models.mjs` (after generating, step of
   `scripts/build.sh build`, runs before `kotlinc` — no jar and no npm package without a green check):
   - the set of generated Kotlin and TypeScript models is **equal** to the set of keys under `components.schemas` in `common/common.yaml`, each model in exactly one file;
     exceptions: schemas of `multipart/form-data` bodies (`BoardSnapshotUpload`, `FileUpload`, `PluginUpload`), which the generators flatten into parameters (`@RequestPart file: Part`, `file: Blob`), and aliases (`type: array`, or a primitive type without `enum`, e.g. the binary `FileContent` → `Resource` / `Blob`);
   - no nested type (inline enum/object in a property);
   - no schema defined outside `common/common.yaml` (Redocly would rename a second `Board` to `Board-2`), none unused;
   - names in PascalCase, no generated-looking names, none that shadow language types (`Unit`, `List`, `String` …).

   Hence: enums and objects that appear in a property get their own key under
   `components.schemas` and are included via `$ref`.

   Not models and therefore not checked: the parameter interfaces
   `<operationId>RequestParams` (e.g. `ListBoardsRequestParams`) in the
   Angular services — they come from `useSingleRequestParameter`, are named
   stably after the operation and are not duplicated anywhere.

**Errors.** Every 4xx/5xx response is a `$ref` to `common/common.yaml#/components/responses/…`,
media type `application/problem+json`, body `ErrorModel` (lint rules
`error-responses-*`). `ErrorModel` has the field names of RFC 9457 (`status`,
`title`, `detail`, `instance`; `type` is deliberately absent = `about:blank`)
plus `code`, `params`, `violations`, `requestId`, `traceId`, `timestamp`.

**ErrorCode** is an application-wide enum: platform codes without a prefix
(`VALIDATION_FAILED`, `MALFORMED_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `METHOD_NOT_ALLOWED`, `NOT_ACCEPTABLE`, `CONFLICT`,
`UNSUPPORTED_MEDIA_TYPE`, `INTERNAL_ERROR`, `BAD_GATEWAY`, `GATEWAY_TIMEOUT`),
domain codes as `<MODULE>_<SUBDOMAIN>_<PROBLEM>`
(`LIBRARY_BOARD_NOT_FOUND`). A published code is never renamed or removed.
**A new code is not a breaking change** — clients must tolerate unknown codes
(treat them like the bare HTTP status).

`BAD_GATEWAY` (502) and `GATEWAY_TIMEOUT` (504) are **never sent by the
backend**. They belong to the proxy in front of it — the frontend's nginx or
Node server that forwards `/api`, or a gateway — which answers with an
`ErrorModel` as `application/problem+json` when the backend is unreachable
(connection refused/reset, DNS) or does not answer in time. `requestId` is the
caller's `X-Request-Id` if it sent one, otherwise a fresh id of the proxy;
`traceId` is absent. Clients treat both as transient (offer a retry). Because
no operation of the backend returns them, they are not listed as responses of
the operations.

**IDs** are UUIDs (`format: uuid`, assigned by the server as UUIDv7) and
`readOnly`. What comes in (`NewBoard`) is a separate schema, distinct from what
goes out (`Board`).

**Security.** Two schemes, set globally as alternatives: `bearerAuth`
(HTTP Bearer, JWT from the OpenID Connect provider) and `oidc`
(`openIdConnect`, for the login in Swagger UI). The token only identifies the
user: there are no permission claims. What a user may do with a board is
decided by the sharing rules in the backend (module `library`); the operation
descriptions name the board role they need. This keeps the API usable with any
OIDC provider (Keycloak by default, Authelia or others by configuration).

**Provider URL in the bundle.** Two stages, so that the same artifact works
everywhere:

1. *Build:* `openapi.yaml` contains the discovery URL of the planned central
   Keycloak (issuer `https://auth.dergeorg.at/realms/dergeorg`,
   `KEYCLOAK_PLACEHOLDER` in `contract.env`). The bundle step of
   `scripts/build.sh` replaces the issuer with `KEYCLOAK_ISSUER` from
   `contract.env` and fails if the placeholder is missing.
2. *Runtime:* the service that serves Swagger UI does not serve
   `/openapi/drawboard-api.yaml` raw from the jar, but replaces
   `openIdConnectUrl` with `<its issuer>/.well-known/openid-configuration`
   (in the backend: `OIDC_ISSUER_URI`). This way Swagger UI signs in locally
   against the dev Keycloak (`http://localhost:18180/realms/drawboard`) or any
   other provider without a separate contract build.

Why not springdoc: its `springdoc.swagger-ui.oauth.*` only sets client ID,
PKCE and scopes; Swagger UI always reads the provider URL from the document.
Why not just the build parameter: then every environment would need its own
artifact — the contract would no longer be one version for all.

**Version.** `info.version` stays `0.0.0` in the repository (in all three
files); the bundle step writes the version from `VERSION` into the bundle. No
version number is maintained anywhere.

## Names

| What | Value |
|---|---|
| Maven artifact | `at.dergeorg.drawboard:drawboard-api-kotlin:<version>` (+ `-sources.jar`) |
| Kotlin packages | `at.dergeorg.drawboard.contract.api` (`BoardsApi`, `FoldersApi`, `SharingApi`, `CollabApi`, `FilesApi`, `FileContentApi`, `PluginsApi`, `PlanningApi`, `UsersApi`), `…contract.model`, `…contract.config` |
| Spec in the jar | `META-INF/resources/openapi/drawboard-api.yaml` → every service with the jar serves it at `/openapi/drawboard-api.yaml` |
| npm package | `@apps/drawboard-api` |

Why `…contract` and not `…api.generated`: the backend has a Gradle module
`api` with the package `at.dergeorg.drawboard.api`. Generated code in the same
package tree would look like code of that module to ArchUnit rules and when
reading. `contract` says what it is and still lives under the application's
root package — so the backend's component scan finds the generated
`EnumConverterConfiguration`. Company projects set `API_GROUP`/`API_BASE_PACKAGE`
in `contract.env` to the company domain and `API_NPM_NAME` to the company
scope.

**npm scope = root namespace of the GitLab project** (`apps` here). GitLab's instance-level npm endpoint only
resolves a scoped package whose scope equals the root namespace of the project
that published it — then consumers need one registry line for all contracts,
independent of group ids. The package is still published at project level
(`openapi:publish`, `CI_JOB_TOKEN`).

Consumer (`.npmrc` in the frontend, checked in, no secret):

```ini
@apps:registry=https://gitlab.dergeorg.at/api/v4/packages/npm/
//gitlab.dergeorg.at/api/v4/packages/npm/:_authToken=${NPM_TOKEN}
```

`NPM_TOKEN`: locally a personal access token with `read_api`, in CI
`$CI_JOB_TOKEN` (this project's job-token allowlist must contain the consumer).

## Build

No Gradle: `scripts/build.sh` does everything (a shell script is enough and
faster - the repository holds no code, only YAML). It is copied **unchanged**
from `ci/components` (`examples/contract-build.sh`); what differs per contract
(coordinates, package, stack, npm name, Keycloak issuer, tool versions) is in
`contract.env`.

Prerequisites: JDK 25 (`java`, `jar`) and Node ≥ 22.12 (`node`, `npm`, `npx`)
on the `PATH`, plus `bash`, `curl`, `git`, `tar`. openapi-generator-cli,
`kotlinc`, oasdiff and the compile-only jars are downloaded on first use in the
versions of `contract.env`, checksum-verified, into `~/.cache/contract-build`.

```bash
scripts/build.sh all                     # lint, breaking, bundle, generate, check, jar, npm package
VERSION=1.2.3 scripts/build.sh build     # build with a version (default 0.0.1-SNAPSHOT)
VERSION=1.2.3 scripts/build.sh install   # build + copy jar/sources/POM into ~/.m2/repository
scripts/build.sh lint                    # lint rules only
scripts/build.sh generate                # only the generators (look at the generated code)
scripts/build.sh breaking                # oasdiff against the last tag (see Versioning)
```

| Command | Result |
|---|---|
| `lint` | `redocly lint` with `redocly.yaml` |
| `bundle` | `build/openapi/openapi.yaml` — bundle with version and Keycloak issuer |
| `breaking` | oasdiff against the bundle of the last tag, report in `build/oasdiff/` |
| `build` | bundle, `build/generated/openapi/` (kotlin-spring), `build/generated/typescript-angular/` (ng-packagr project), model check (see Rules), `build/libs/drawboard-api-kotlin-<version>.jar` (bundle inside) + `-sources.jar`, Maven layout with POM in `build/maven-staging/`, `build/npm/apps-drawboard-api-<version>.tgz` |

### Kotlin generator (kotlin-spring 7.25.0)

`useSpringBoot4` (Jakarta, Spring 7, Jackson 3), `reactive=true` (suspend functions
for WebFlux + coroutines; `apiReactive=false` for Spring MVC), `interfaceOnly` +
`skipDefaultInterface` (a new operation is a compile error in the backend until
it is implemented), `useTags` (one interface per tag), `useResponseEntity`,
`useBeanValidation` + `useSpringBuiltInValidation` (violated parameter constraints
→ 400 instead of 500), `annotationLibrary=swagger2` (`@Operation`/`@ApiResponse` on
the interface, springdoc reads them), `documentationProvider=none`,
`exceptionHandler=false` (the backend writes `ErrorModel` itself).

The jar is compiled with `kotlinc` (`KOTLIN_VERSION`, equal to the Boot BOM's
`kotlin.version`) and the all-open plugin (preset `spring`: the generated
`@Configuration` is open). All dependencies are compile-only (resolved from the
Spring Boot BOM `SPRING_BOOT_VERSION`): the POM lists only `kotlin-stdlib`, the
versions are determined by the backend's Boot BOM. The backend needs
`spring-boot-starter-webflux` (or `-webmvc`), `spring-boot-starter-validation`,
`tools.jackson.module:jackson-module-kotlin`, `kotlinx-coroutines-reactor` and
the Swagger annotations (they come with springdoc).

**Kotlin types** (type mappings `UUID=kotlin.uuid.Uuid,DateTime=kotlin.time.Instant`,
since 2.0.0): ids (`format: uuid`) are `kotlin.uuid.Uuid`, times
(`format: date-time`) `kotlin.time.Instant` - in models and in path/query
parameters, no `java.util.UUID` or `java.time` in the generated code.
`kotlin.uuid.Uuid` is still experimental in Kotlin 2.3: the jar is compiled
with `-opt-in=kotlin.uuid.ExperimentalUuidApi`, and the backend needs the same
flag, Jackson (de)serializers for `Uuid`/`Instant` and a
`Converter<String, Uuid>` for path variables. TypeScript is unchanged
(`string`). There is no `format: date` (lint rule `no-date-format`).

```kotlin
@RestController   // required: interfaces are not scanned
class BoardsController(private val boards: BoardsApiUseCase) : BoardsApi {
    override suspend fun getBoard(boardId: Uuid): ResponseEntity<Board> = …
}
```

```yaml
springdoc:
  swagger-ui:
    url: /openapi/drawboard-api.yaml   # the contract from the jar, not springdoc's reconstruction
```

### Angular client (typescript-angular 7.25.0)

`ngVersion=22.0.0`, `providedIn=root`, `fileNaming=kebab-case`,
`useSingleRequestParameter` (`listBoards({ page, size })`), `supportsES6`, and:

* `enumPropertyNaming=UPPERCASE` — enum keys are the wire values
  (`ErrorCode.VALIDATION_FAILED`), the same identifier as in Kotlin, in logs and
  as i18n key.
* `nullSafeAdditionalProps=true` — `params?: { [key: string]: string | undefined }`.
* `stringEnums` stays `false`: enums are `const X = {...} as const` plus a string
  union, so a code from a newer contract is just an unknown string at runtime.

```ts
// app.config.ts
providers: [provideHttpClient(withFetch()), provideApi('/api')]
// component / service
private readonly boards = inject(BoardsService);
this.boards.listBoards({ page: 0, size: 20 });
```

## Versioning and breaking changes

Commit messages determine the version (semantic-release): `fix:` → patch,
`feat:` → minor, `feat!:` or `BREAKING CHANGE:` → major; `chore:`, `docs:`,
`build:`, `ci:` → no release. A contract change that is meant to reach backend
and frontend is therefore `feat:` or `fix:`.

`scripts/build.sh breaking` compares the bundle with that of the last tag
(oasdiff 1.32.1, downloaded on demand and verified by checksum). If oasdiff
finds a breaking change and no commit since the tag announces it
(`!` or `BREAKING CHANGE:`), the check fails — otherwise consumers would get a
break as a minor update.

```bash
scripts/build.sh breaking                      # against the last tag
BASE_REF=v1.2.0 scripts/build.sh breaking      # against a specific ref
BREAKING_CHECK=warn scripts/build.sh breaking  # report only
```

`oasdiff-ignore.txt` excludes **individual** findings that break formally but
change nothing in behavior — for example a `pattern` added to the contract for
a rule the backend has always enforced with 400. One line per finding
(`<METHOD> <path>` plus the text from oasdiff), `#` comments allowed; remove
again after the next release.

`oasdiff-severity.txt` adjusts two rules:

* `response-property-enum-value-added info` — a new `ErrorCode` is **not** a
  breaking change (decision: clients must tolerate unknown codes).
  Caution: this applies to every enum in responses.
* `response-optional-property-removed err` — removing an optional response
  property **is** a breaking change (typed frontends rely on it).

## Pipeline

The pipeline uses ci/components 2.8.0: `version`, the component `openapi` in
**script mode** (`build-script: scripts/build.sh`) and `release`. All jobs run
in `eclipse-temurin:25-jdk` with Node, git and curl added by the component.
Jobs:

* `openapi:lint` — `scripts/build.sh lint`, then `bundle`.
* `openapi:breaking` — `scripts/build.sh breaking`: oasdiff against the bundle
  of the last tag with the severity overrides (by default a new enum value in a
  response is not breaking, plus `oasdiff-severity.txt`) and
  `oasdiff-ignore.txt`; an undeclared breaking change fails.
* `openapi:build` — `scripts/build.sh build` with `VERSION=$APP_VERSION`:
  model check, jar, sources jar, POM and `maven-metadata.xml` in
  `.ci/maven-staging`, the `.tgz` of the Angular package, the stamped bundle.
* `openapi:publish` — only when a release is due: uploads exactly those files
  to the Maven registry of this project (no rebuild), the `.tgz` to the npm
  registry of this project, the stamped bundle as generic package
  `openapi/<version>/openapi.yaml`, all with `CI_JOB_TOKEN`.
* then `release` — tag `vX.Y.Z` + GitLab release.

Backend and frontend read through the group endpoint of `apps/drawboard`;
for that, this project needs `apps/drawboard` in its job-token allowlist
(set up by Georg's script `05-contract-und-regeln.sh`).
