# drawboard-frontend

Angular frontend of **Drawboard**, the self-hosted collaborative whiteboard
(`../docs/architecture.md`). It belongs to the backend in `../backend` and consumes the API
contract in `../api` as the generated npm client `@apps/drawboard-api`.

Milestone **M0**: login, "My boards" (list, create, rename, delete). Milestone **M1**: the
board page is a full-height editor on **our own whiteboard engine** (`src/board-engine/`, plain
TypeScript, concept in `../docs/board-engine.md`), synchronised live through the collaboration
provider. Milestone **M2** (contract `@apps/drawboard-api` 1.2.0): folders, shared with me,
trash, the share dialog (people, links), guest access through share links, version history and
`.drawboard` export/import - see the sections _Routes_, _Guest mode_ and _Export and import_.
Milestone **M3** (contract 1.3.0): uploaded files (images, videos, PDFs, Office documents
converted to PDF) as file blocks, Mermaid diagrams, and **plugins** - sandboxed plugin blocks,
the admin page, the plugin SDK with a sample plugin - see _Files_, _Diagrams_ and _Plugins_.
Milestone **M4** (contract 1.4.0): the **kanban** block, **story cards** and **planning poker**
on them, and the hardening tests (guest allowlist, plugin sandbox, nginx header check) - see
_Kanban_, _Story cards_, _Planning poker_ and _Tests_.

Angular 22.2 (standalone, zoneless, OnPush by default, signals everywhere), client-side
rendering (the whole app is behind a login - no SSR), Tailwind 4 + DaisyUI 5 with the
**dergeorg** brand, OIDC login with `oidc-client-ts`, Signal Forms, Grafana Faro, Vitest,
Playwright. Built from the house reference frontend in `samples/` (skill `web-frontend`);
deviations are listed in `../CLAUDE.md`.

## Layout

```
src/
  main.ts                    loads /config.json, then bootstraps App with appConfig(config)
  index.html, styles.css     global styles: Tailwind entry + DaisyUI + dergeorg brand tokens
  config/
    config.ts                appConfig(runtimeConfig): router, HttpClient + interceptors,
                             generated client, OIDC client + OidcAuth, Faro
    router.ts                top level only: one lazy child router per domain
  environments/
    environment.ts           image build (dev AND prod) - no URLs
    environment.development.ts   ng serve: inline runtime config for the local dev stack
  board-engine/              the whiteboard engine: plain TypeScript, no Angular, no RxJS
                             (ESLint enforces it). model/ (Y.Doc schema), renderer/ (DOM + SVG
                             layers), tools/, input/, text/ (text editing), blocks/ (built-in
                             block types: sticky, text, shape, file, mermaid, kanban, story),
                             collab/
                             (drawboard.v1 provider), io/ (board.json, .drawboard archive, data
                             URL: validation + limits), files/ (file source contract, pdf.js
                             view), diagrams/ (Mermaid + DOMPurify), plugins/ (plugin host,
                             frames, protocol), undo.ts, camera.ts, engine.ts (BoardEngine)
  plugin-sdk/                the SDK plugin authors bundle into their frame (no dependencies,
                             must not import the board), samples/counter/ (sample plugin)
  app/
    app.*                    root: header, <router-outlet>, footer, toasts
    components/
      layout/                header (app name, display name, sign out), footer
      pages/
        boards/              boards.routes.ts, board-actions.ts / folder-actions.ts /
                             share-actions.ts (domain commands), board-list/ (/boards: recent,
                             my boards + folders, shared with me, trash), folder-tree/ (sidebar),
                             board-card/, share-dialog/ (people + links), version-history/,
                             board-page/ (/boards/:boardId, the editor), board-canvas/ (hosts
                             the engine, drop and paste), board-collab.ts (live connection, 4410),
                             board-transfer.ts + board-importer.ts (export, import),
                             board-files.ts (metadata + signed URLs), board-uploads.ts +
                             board-upload-panel/, board-diagram-editor/ (Mermaid source),
                             board-plugins.ts (runs the enabled plugins), board-kanban-card/
                             (card panel), board-story-editor/, poker/ (board-poker.ts,
                             poker-poller.ts, board-poker-dialog/, board-poker-rounds/)
        admin/               admin.routes.ts (/admin), plugin-admin/ (/admin/plugins),
                             plugin-card/
        guests/              guests.routes.ts (/s), guest-join/ (opens a link), guest-folder/,
                             guest-badge/
        open/                open.routes.ts (/open), open-from-link/ (board from a data URL)
        errors/              errors.routes.ts, forbidden/, not-found/
      shared/                confirm-button, dg-logo, field-errors, load-error, pager,
                             role-badge, toast-outlet
    guards/                  auth-guard, guest-guard, admin-guard
    services/                auth (abstract) + oidc-auth + oidc-client (UserManager factory),
                             auth/error/trace interceptors, api-error-handler, error-messages,
                             toasts, faro, navigation-tracing, page-title, runtime-config
    test/                    cross-cutting test helpers (fake auth, fake OIDC client, HTTP
                             testing, DOM, fixtures, recorded spans)
    util/                    api-error, violations (server errors -> form fields), tracing
                             (@WithSpan), url, ...
public/                      favicon, silent-renew.html + .js (silent sign-in iframe page)
scripts/plugin-bundle.mjs    bundles a plugin into the ZIP an admin installs
scripts/check-headers.mjs    checks the nginx template's security headers against S7.5
e2e/                         Playwright: auth.setup.ts, support/, boards/, user/, tracing/;
                             plugins/, content/ and headers/ run without backend (project
                             "sandbox"), guests/ against the app with a mocked API ("mocked")
deploy/                      nginx template of the image, compose files for dev and prod
```

The house rules of the skill apply unchanged: three files per component (`.ts`, `.html`,
`.spec.ts`), Tailwind first, modern Angular APIs only (enforced by `@ci/eslint-plugin`), names
without type suffix, selector prefix `drawboard-`, every domain has `<domain>.routes.ts`,
`@WithSpan('<Class>.<method>')` on user actions, a message on every `expect`.

## Routes

| Route                               | Who                | What                                                                                                                                    |
| ----------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/boards?view=recent`               | signed in          | top level of the user's space, newest first                                                                                             |
| `/boards?view=mine&folder=<id>`     | signed in          | folders and boards of the open folder; the sidebar tree creates, renames, moves, trashes; drag a card onto a folder or use _Move to..._ |
| `/boards?view=shared[&folder=<id>]` | signed in          | what others shared (boards and folders); a shared folder lists its boards                                                               |
| `/boards?view=trash`                | signed in          | restore, or delete forever after a confirmation (the server purges after 30 days)                                                       |
| `/boards/:boardId`                  | signed in          | the editor; Share (owner manages, others read the member list), menu: export, link, import, versions                                    |
| `/open#v1.<data>`                   | signed in          | a board from a data URL, read-only, "Opened from a link, not saved", _Save a copy_                                                      |
| `/s#<token>`                        | **public**         | opens a share link (see _Guest mode_)                                                                                                   |
| `/s/b/:boardId`, `/s/f/:folderId`   | guest session only | the guest editor / the board list of a shared folder (`guestGuard`)                                                                     |
| `/admin/plugins`                    | instance admins    | install, review, grant, enable and remove plugins (`adminGuard` on `CurrentUser.admin`; the backend decides by the groups claim)        |

Outside the app, served by the backend through the image's nginx: `/files/{id}?v=&exp=&sig=`
(signed file URLs) and `/plugin-assets/<id>/<version>/<sha256>/...` (plugin files and the
generated frame document).

## Guest mode

A share link has the form `<origin>/s#<token>` (S1). `/s` reads the token from `location.hash` in
the constructor and removes it from the address bar at once (`history.replaceState`). It then
calls `exchangeShareToken` (password prompt for `LIBRARY_SHARE_PASSWORD_REQUIRED/INVALID`, name
prompt for guest links, 404 -> "invalid or expired", 429 -> wait message with `Retry-After`).
Signed-in visitors go to the board / the shared folder in the library. Anonymous visitors on a
guest link become **guests**:

- **Where the secrets live:** the link token and the guest JWT are private fields of
  `GuestSession` - memory only. Never localStorage, sessionStorage, a cookie, the URL, a log or a
  span (`GuestActions.exchange` has no span attributes; Faro strips URL fragments). A reload,
  _Leave_, the end of the session and a new exchange delete them.
- The JWT is the bearer for the few operations guests may call (`getBoard`, `listBoards` with
  `folderId`, `createCollabTicket`, `refreshGuestSession`); `Auth.token()` returns it in guest
  mode. It is renewed with `refreshGuestSession` a minute before it expires (timer + on demand).
  12 hours after the first exchange the session ends with a message on `/s`; so do a revoked
  link (404) and a refused token (401).
- **Link for signed-in users opened while signed out:** the page asks to sign in and to **open
  the link again afterwards**. The token is deliberately not kept across the redirect (the only
  places would be `sessionStorage` or the OIDC `state`, both script-readable and left behind when
  the login is abandoned).
- Guest UI: only the board (or the board list of the shared folder), a **Guest** badge with the
  name and _Leave_; no library, no Share, no rename, no menu. Presence marks every participant
  with `From.guest = true` with a **G** badge, whatever the name says.

## Export and import

- **Export** (editor menu): `<title>.drawboard`, a ZIP (`fflate`) with `board.json` (readable
  JSON of the document, `schemaVersion` 1) and `snapshot.yjs` (for tools).
- **Import** (editor menu): a `.drawboard` or a plain `board.json` becomes a **new** board
  (`createBoard`, then the normal collaboration traffic writes the document in acknowledged
  pieces below the 1 MiB frame limit; a failed import deletes the half-filled board). Limits
  (S5.5), all enforced in `board-engine/io/`: ZIP <= 200 MB, unpacked <= 500 MB and <= 100 MB
  per entry, <= 1000 entries, no `..`/absolute/backslash paths, `board.json` <= 20 MB (counted
  while inflating), known `schemaVersion`, per block type schema (unknown types are refused),
  hex colours only, finite coordinates, <= 20 000 blocks. **`snapshot.yjs` is never read** (not
  even decompressed).
- **Copy as link**: `<origin>/open#v1.<base64url(raw DEFLATE of board.json)>`, <= 1 MB
  compressed, references only. `/open` needs a login, inflates with an abort at 10 MB, validates
  as above, opens no collaboration socket and no embeds. Note: the data is in the fragment, so
  it never reaches a server; while the login redirect runs it is part of the return URL in the
  OIDC `state` (sessionStorage, deleted when the callback is processed).

## Zoom

From **2 % to 800 %** (`board-engine/camera.ts`, Miro-like). The zoom pill at the bottom right
zooms out, shows the level (click = 100 %), zooms in and fits the whole board.

| Keys             | What                         |
| ---------------- | ---------------------------- |
| Ctrl/Cmd + `+`   | zoom in                      |
| Ctrl/Cmd + `-`   | zoom out                     |
| Shift+1          | fit to content (every block) |
| Shift+0, Ctrl+0  | 100 %                        |
| Ctrl/Cmd + wheel | zoom at the pointer (pinch)  |

Far out the board stays fast (`board-engine/renderer/simple-view.ts`):

- **Level of detail:** below 15 % every block is one plain box in its colour (sticky colour,
  shape fill, frame fill; everything else neutral grey), frames keep their title at a fixed
  screen size above them. No text layout, no plugin frames, no images, PDFs, videos or Mermaid
  renders. Back to the full views above 18 % (hysteresis: zooming around the threshold does not
  remount every block). Colours still go through `safeColor` (S5.2); plugin types never give
  one. Text editing stops while simplified.
- **Dot grid:** fades between 15 % and 6 %, below that the background is not painted at all.
- **Culling:** the mounted area is computed once per pass (viewport + 300 screen px), so a pass
  over thousands of blocks is one rectangle test each; a pan that keeps the same blocks in view
  remounts nothing.
- **Measured** (`e2e/guests/zoom-out.spec.ts`, Chrome on an M-series Mac, `ng serve`): 5000
  blocks at 2 % are 5000 boxes (10 055 elements in the world layer); one pan or wheel-zoom step
  including two frames takes 33 ms median (= two frames at 60 Hz), at most 41-46 ms; the
  slowest zoom-out step is the last one with full views (17 %, 76-95 ms). The same board without
  level of detail needs **8 s** for the step that mounts all 5000 full views, and pans at up to
  69 ms per step.

## Follow and present

Like Miro: a click on someone's avatar in the participants pill opens their menu.

- **Follow**: my camera glides to their view (centre and zoom) and tracks it live. A frame in
  their colour around the canvas and "Following X" with **Stop** show it; any own pan, zoom,
  zoom shortcut, fit or **Esc** stops it. If they leave, following stops with a notice. Everyone
  may follow, guests and viewers included.
- **Ask to follow me** (one person; repeat to add more, at most 50) and **Bring everyone to me**
  (the people icon in the pill): only for **signed-in owners and editors**. The summoned see
  "X is presenting - you're following" with **Stop** and **Ignore**; stopping is local and
  final for that summon. I see "You are presenting - n following: ..." and **End**; when I end,
  my followers stop with a notice.
- **Awareness payload** (`board-engine/collab/awareness-state.ts`), next to cursor and
  selection: `viewport {x, y, zoom}` (centre, rounded to world units, zoom to 4 decimals;
  sent with the rest of the state, at most 10 per second), `following <client id>`,
  `summon {id, targets: "all" | client ids}`. No free text: every name shown comes from the
  server's `From` (S2.6). Every received field is validated on its own - finite numbers,
  |x|, |y| <= 10 000 000, zoom 2 %-800 %, client ids uint32, summon id 1..2^31-1, 1-50 targets,
  own properties only, unknown fields ignored, a frame above the awareness limit (16 KiB) not
  parsed; a field that fails is treated as absent.
- **Receiver rules** (`board-engine/collab/follow.ts`, `board-follow.ts`): the server relays
  awareness for every participant (S2.4), so the receiver decides. A summon from a guest
  (`From.guest`) is never followed. A signed-in receiver reads the board's member list once
  (again after 60 s for an unknown sender) and follows only the owner or a user with an EDITOR
  grant (an EDITOR group grant cannot be resolved per person and is accepted; a failed read
  refuses). A guest receiver cannot read members (S1.10) and accepts signed-in senders. Each
  (sender, summon id) is decided once; at most one summon per sender per 15 s is honoured;
  "Ignore their summons" holds for the session (keyed by `From.id`).

## Copy and paste

Like Miro: select on the canvas, then

| Keys       | What                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ctrl/Cmd+C | copy the selection                                                                                                                                                                                                          |
| Ctrl/Cmd+X | cut (copy, then delete; one undo step)                                                                                                                                                                                      |
| Ctrl/Cmd+V | paste at the pointer, or in the middle of the view when the pointer is not over the board; pasting the same content at the same spot again steps 20 px down and right; the pasted items become the selection; one undo step |
| Ctrl/Cmd+D | duplicate next to the original                                                                                                                                                                                              |

- Only on the canvas: while a text is edited (or any text field, dialog or control inside a block
  has the focus) the browser's own copy and paste apply. Viewers, commenters and VIEWER-link
  guests can copy but not cut or paste.
- **What is copied:** the selected blocks and strokes, the selected connectors whose block ends
  are copied too, and every connector whose two ends are copied blocks. Pasted items get new
  ids; connector ends and parent links are remapped, a parent that is not copied along is
  dropped.
- **System clipboard:** `copy`/`cut`/`paste` ClipboardEvents (synchronous `setData`/`getData`,
  no permission prompt). The content goes under `application/x-drawboard+json` (on paste
  `web application/x-drawboard+json` is read as well) as an envelope
  `{ drawboard: "clipboard", version: 1, sourceBoard, content: <board.json> }`, plus a
  `text/plain` fallback with the block texts in reading order. So pasting works across boards
  and tabs of the same browser, and into other programs as text.
- **The clipboard is untrusted input** (`board-engine/io/clipboard.ts`): at most 512 KB (so one paste stays below the 1 MiB Yjs update limit) (checked
  before parsing), 2000 blocks, 2000 connectors, 2000 strokes; the content runs through the
  same validators as `.drawboard` import (per block type, `Object.hasOwn` lookups, hex colours
  only, finite coordinates, references). Block types that are neither built in nor of a plugin
  enabled on this board are left out with a notice (their props are checked by the plugin
  protocol's rules: plain JSON, no `__proto__`/`constructor`/`prototype`, <= 64 KiB). File
  blocks are pasted only into the board they come from (the envelope names it); elsewhere they
  are left out with a notice - their file id gives no access there. A story card's planning
  poker round is never pasted.
- **Text from outside** (`text/plain` only, HTML is ignored) becomes one sticky note
  (at most 100 000 characters). A pasted ` ```mermaid ` fence still becomes a diagram and
  pasted files are still uploaded (`board-canvas` takes those first).

## Frames

`core.frame` (tool **F**, toolbar _Frame_): an area with a title that holds other blocks, e.g. to
model a system or to move a group of cards at once. Rules (`board-engine/model/frames.ts`):

- **Membership:** a block belongs to the innermost frame under its centre after it was created,
  moved, pasted or inserted (`parent` in the Y.Doc); dragging it out clears it. Drawing a frame
  around blocks takes them in. Frames nest at most 8 deep; a block is never put into itself or
  a frame inside it.
- **Moving** a frame moves everything inside it (one undo step). Drag it by the title, or once it
  is selected anywhere; a drag that starts on the empty inside of an unselected frame is a marquee
  (a marquee selects a frame only when it covers it completely). A click on the empty inside or
  the title selects the frame, a click on a child the child.
- **Resizing** never moves children and never takes them out: a child left outside after a resize
  keeps its frame (Miro). Blocks the frame now covers on its own level are taken in.
- **Deleting** a frame deletes its contents (one undo step); the context toolbar offers _Remove
  frame, keep contents_ (children move to the next frame out). Copy, cut and duplicate take the
  contents along; a copy of a block inside a frame stays in that frame.
- **Look:** title (the block's text, edited in the title strip by double-click or Enter, one line,
  at most 200 characters), a fill from the palette (`safeColor`, or `transparent`). Frames are
  drawn in their own layer below connectors and every other block; a nested frame above the one
  around it.
- **Import, export, clipboard:** parent links are kept and validated - the parent exists, is a
  frame, no cycles, at most 8 deep. **Collaboration:** concurrent edits can produce any link
  (A into B while B goes into A); every client reads it with the same rule (dangling links and
  links to non-frames do not count, frames on a cycle are top-level, too-deep frames are
  top-level), so all see the same tree and nothing loops.

## Tables

Georg's idea - "many frames inside a parent frame" - taken literally (`board-engine/model/tables.ts`):
a table is a `core.frame` with `props.table = { rows, cols, colWidths, rowHeights }`, and its
cells are `core.frame` children with `props.cell = { row, col }`; row 0 is the header row (titled
"Column 1", ...; other cells may get titles too). No `core.table` type: every frame rule
(membership, z-order, moving, deleting, clipboard, import validation) applies unchanged, and a
broken table simply is frames.

- **Creating:** the table tool (**G**, toolbar _Table_) places a 3 x 3 table with a header row
  where you click (one undo step).
- **Sorting cards:** a card dropped into a cell becomes the cell's child (frame rule: innermost
  frame under its centre).
- **Moving** the table (by its title, or a selected cell by its title) moves cells and cards; a
  cell never moves, copies or duplicates alone - it stands for its table. Delete on a single cell
  does nothing (rows and columns go through the toolbar).
- **Context toolbar** for a table or a cell: _Add row_ (below the cell, or at the end), _Add
  column_ (right of the cell, or at the end), _Remove row_ (never the header row), _Remove
  column_ (never the last one). **Cards in a removed row or column are kept**: they stay where
  they are and belong to the table frame from then on (no confirmation needed, nothing lost;
  dragging them re-homes them).
- **Resizing** a cell by its handles sets its column's width and its row's height; resizing the
  table scales all columns and rows. The grid is laid out again from `colWidths`/`rowHeights`; a
  cell that moves takes its cards along, a cell that only changes size moves nothing inside.
- **Validation:** import and paste check `table` and `cell` props (counts <= 50 rows / 20 columns,
  sizes, exactly one cell per row and column). Whatever does not form an intact table - also
  after a merge of concurrent edits (one person adds a row while another adds a column) - is
  plain frames: no table toolbar, nothing crashes, nothing is lost.

## Files

A file belongs to one board (S4.1). The block `core.file` stores **only the `fileId`** in the
document - never a URL (S4.4); `.drawboard` export/import keeps the id (on another board the
block shows "not available").

- **Upload** (editors and owners who are signed in, never guests, S1.9): the toolbar's upload
  button, **drop** files on the canvas (the block lands where they were dropped) or **paste**
  an image. Checked before sending: extension allowlist (png, jpg/jpeg, gif, webp, mp4, webm,
  pdf, docx, xlsx, pptx, odt, ods, odp), **no SVG** (S4.3), at most **50 MB** (video **500
  MB**), at most 30 files per drop (the backend allows 30 uploads a minute). One file at a time
  with progress in the upload panel; the server's answer decides (type sniffed from the content,
  quotas, 500 files per board) and a refusal stays in the panel with the reason and request id.
  These client limits are the backend defaults; if a deployment raises them, raise
  `MAX_FILE_BYTES`/`MAX_VIDEO_BYTES` in `board-uploads.ts` and `client_max_body_size` in nginx.
- **Signed URLs** (`BoardFiles`): metadata from `listFiles` (once) and `getFile`, URLs from
  `getFileUrls` - every block mounted in the same task shares one request (at most 100 ids).
  They live in memory only, are renewed **5 minutes before `expiresAt`**, are dropped for files
  no block shows, and are never logged, put into the document, telemetry (Faro strips queries)
  or storage (S7.2). Only the documented form `/files/<uuid>?...` is accepted; with a files
  origin it is put in front. A loaded image or a playing video keeps its URL; a load that fails
  later (expired) asks for new URLs and continues (video at the same position).
- **Images** inline (`<img>`, no referrer), **videos** with the browser's controls (ranges),
  **PDFs** and **converted Office documents** with pdf.js (below), everything else a card.
  Office documents show "Converting to PDF..." while `conversion` is `PENDING` (polled with
  `getFile`, 2 s growing to 30 s), "no preview" when it `FAILED`. Every download is the
  original with its name (`rel=noopener noreferrer`); Office downloads say that the file may
  contain macros (S4.11).
- **pdf.js** (`board-engine/files/pdf-view.ts`, S4.9): its own lazy chunk; worker, standard
  fonts, CMaps, ICC profiles and the image-decoder wasm are copied to **`/pdfjs/`** by
  `angular.json` and served from our origin (`worker-src 'self'`); the bytes are fetched by us
  (no credentials, no referrer, no redirects, size-capped) and passed as data, so pdf.js never
  sees a URL; `enableXfa: false`, no annotation layer, the scripting sandbox (QuickJS) is not
  shipped. pdf.js 6 has no `eval` path any more (the `isEvalSupported` switch is gone) and the
  CSP has no `'unsafe-eval'`. Pages render to a canvas with a pager; a password-protected PDF
  says so.

## Diagrams

`core.mermaid` (architecture 3.7): the toolbar's **Diagram** button, pasting a
` ```mermaid ` fence or dropping a `.mmd` file adds one; double-click opens the **source
panel** (the block on the canvas is the live preview). The source is the block's `Y.Text`
(collaborative, every keystroke the smallest edit), at most **50 KB** (S5.1).

Rendering (`board-engine/diagrams/mermaid-renderer.ts`): Mermaid and DOMPurify load in their own
lazy chunks; renders are debounced, run one at a time and never inside the transaction that
changed the text; errors show as text. S5.1: `securityLevel: 'strict'`, `htmlLabels: false`
(also `flowchart.htmlLabels`), `maxTextSize: 50000`, `maxEdges: 500`, and these keys plus
`themeCSS`, the fonts and `dompurifyConfig` are declared **secure**, so `%%{init}%%` directives
or front matter cannot change them. The SVG goes through DOMPurify (svg + svgFilters profiles,
forbidden: `foreignObject`, `script`, `a`, `image`, `iframe`, `object`, `embed`) and comes back
as a DOM fragment (never `innerHTML`); CSS `url(...)` other than `#id`, `@import` and every
`href` that does not point into the SVG are removed. **mermaid stays on 11.x**: mermaid 12
depends on `elkjs` (EPL-2.0 or GPL-3.0), which the licence rule of the project excludes.

## Plugins

Runtime plugins (architecture 3.8, S3; protocol: `../api/docs/plugin-protocol.md`). Built-in
blocks (`core.*`) are the only trusted ones; **everything installed at runtime runs in a
sandboxed frame**, there is no switch to promote a plugin (S3.1).

**On a board** (`board-engine/plugins/`, wired by `BoardPlugins`):

- The enabled plugins come from `listEnabledPlugins` when a board opens, **again every minute
  and when the tab becomes visible**; a plugin that is no longer listed loses all its frames at
  once and its blocks show "Plugin: <id> - not available", their data kept (S3.10).
- Every plugin is validated first: id and block types outside `core.`/`drawboard.`, block types
  in the plugin's namespace, asset base exactly `/plugin-assets/<id>/<version>/<sha256>/` on the
  app origin - or, when `pluginOrigin` is configured, only on that origin - and a pseudonym of the
  documented form. Anything else is ignored.
- A plugin block is a frame `sandbox="allow-scripts"` (nothing else), `allow=""`,
  `referrerpolicy="no-referrer"`, `loading="lazy"`, `src=<assetBase>__drawboard/frame.html`
  (generated by the backend with the frame CSP, S3.3/S3.6), created only while the block is on
  screen and **at most 50 at once** - the rest shows "paused" until a frame is free (S3.2). A
  badge "Plugin: <id>" frames it and is the handle to move the block (S3.11). The frame shows
  once the plugin answered `ready` (10 s, else "did not start"); a frame that navigates itself
  is stopped.
- **Protocol** (S3.7): one `MessageChannel` per frame; the window is never listened to. Every
  message is checked in this order: token bucket 100/s, transferred ports, plain JSON, 256 KiB,
  envelope (`type`, `v` = 1, `requestId`, `payload`), known type, payload schema; at most 32
  pending requests, an answer within 10 s; more than 500 dropped messages a minute stop the
  frame.
- **Capabilities** are enforced by the host (S3.8): `block.props` (own block, 64 KiB, edit
  mode, editor/owner), `block.resize`, `board.read` (paged by 500, props only of the plugin's
  own types, no user data), `ui.toast` (shown as text), `ui.openLink` (a dialog shows the target
  host, opened with `noopener,noreferrer`), `storage` (through `getPluginStorage`/
  `putPluginStorage` with the user's token - the frame has none -, 200 KiB per value, 1 MB in
  total, retried 3 times on a version conflict, never written by guests or viewers). `init`
  carries the **pseudonym** `userPseudonym`, never the user id. `export.register` and
  `import.register` answer `NOT_ALLOWED`: service instances are not built yet.

**Admin page** `/admin/plugins` (instance admins, link in the header and the account menu):
upload a ZIP (at most 20 MB) - a new plugin is installed **disabled with nothing granted**, a
higher version of an installed id upgrades it; per plugin the SHA-384 of the bundle (compare it
with the publisher's), the requested capabilities with what each allows (network hosts and
media types listed one by one) as grants, enable/disable, remove (with confirmation).

**Writing a plugin** with the SDK (`src/plugin-sdk/index.ts`, to be published as
`@apps/drawboard-plugin-sdk`):

```ts
import { defineBlock } from '../../index'; // in an own project: '@apps/drawboard-plugin-sdk'

defineBlock((root, ctx) => {
  const count = document.createElement('output');
  const show = () => (count.textContent = String(ctx.props()['count'] ?? 0));
  ctx.on('block.changed', show);
  show();
  count.addEventListener('click', () => {
    if (ctx.canEdit() && ctx.can('block.props')) {
      void ctx.setProps({ count: Number(ctx.props()['count'] ?? 0) + 1 });
    }
  });
  root.append(count);
});
```

`connect()`/`defineBlock()` accept only the first connect message of the parent window that
carries one port; the context offers `props()`, `size()`, `mode()`, `can()`, `canEdit()`,
`on(event)`, `setProps`, `resize`, `readBoard` (all pages), `toast`, `openLink` (false when the
user declined), `storage.get/set/keys`; refused requests reject with `PluginError` (`code`).
Next to the entry module a plugin has a `drawboard-plugin.json` (id, version, entry,
`minHostVersion` 1.0.0, block types, requested capabilities). Build the ZIP with

```bash
npm run plugin:sample                                  # src/plugin-sdk/samples/counter
node scripts/plugin-bundle.mjs <plugin dir> [out dir]  # <dir>/drawboard-plugin.json + <dir>/index.ts
```

which bundles `index.ts` with the SDK (esbuild) into the manifest's `entry` and writes
`dist/plugins/<id>-<version>.zip` with fixed timestamps (same source, same SHA-384), printing
the SHA-384 and SHA-256. Install it on the Plugins page, grant what it needs, enable it; its
block types appear in the toolbar's **Plugin blocks** menu. Package rules (enforced by the
server): ZIP <= 20 MB, <= 200 entries, <= 50 MB unpacked, only `.js .mjs .css .json .png .jpg
.jpeg .gif .webp .woff2 .txt .md` - no HTML, SVG or WebAssembly.

**Third-party plugins stay off in production** until "Before enabling in production" of the
security decisions is done (S3.4 decided, main-app CSP with `frame-src` limited, the sandbox
negative tests in the pipeline, audit events).

## Kanban

`core.kanban` (architecture 3.10, `board-engine/blocks/kanban.ts` + `kanban-model.ts`) is a
built-in, trusted block that edits its own data in place: the engine hands trusted block types a
`BlockHost` (board, undo steps, selection, requests to the app); plugin blocks never see it.
Toolbar: _Kanban_ adds one with three columns.

- **Columns**: add, rename, move left/right, delete (with their cards), at most 20.
- **Cards** (at most 500): title, **assignee** (display name of a board member, picked from
  `listBoardMembers` in the card panel; guests may not read the member list - S1.10 - and see
  the name only), **due date** (`YYYY-MM-DD`, overdue in red), **labels** from a fixed palette
  of seven (the card stores the key, the colour goes through `safeColor`, S5.2), **story
  points** (0-999).
- **Mouse**: drag a card into another column or position; drop it outside the kanban to turn it
  into a **sticky note** on the canvas, with **Shift** into a **story card** (title, points as
  estimate). One undo step brings the card back. A click opens the card panel.
- **Keyboard**: cards are focusable; Enter/Space opens the panel, Delete removes the card,
  arrows move the focus, **Alt+arrows move the card** (up/down within the column, left/right
  to the neighbour column). The panel's _Move to canvas_ is the keyboard way of dragging out.
  Keys and wheel inside a block's own controls (`data-be-interactive`, `data-be-scroll`) stay
  with the block, so Delete on a card never deletes the whole kanban.
- **Undo**: every edit is one step of the board's undo (`Y.UndoManager`, local origin only).

Y.Doc schema (block props):

```
props: Y.Map
  title     string
  columns   Y.Map<columnId, Y.Map { title: string, order: number }>
  cards     Y.Map<cardId,   Y.Map { column: string, order: number, title: string,
                                    assignee: string | null, due: string | null,
                                    labels: Y.Map<label, true>, points: number | null }>
```

One Y.Map per column and card, keyed by a UUID; the position is a field (`column` + fractional
`order`, renumbered in the same transaction when the gap runs out), so a move is two field
writes, never delete-and-insert: two people moving the same card cannot duplicate it, and an
edit of a card survives a concurrent move. A card whose column was deleted concurrently shows in
the first column. Reads are defensive (unknown ids, wrong types and anything past the limits are
skipped). In `board.json` a kanban is stored as lists (`columns`, `cards`, `labels`) and
validated field by field with the limits above (S5.5); `duplicate` clones the nested types.

## Story cards

`core.story` (`blocks/story.ts` + `story-model.ts`): a scrum story with title, description,
acceptance criteria and estimate. Toolbar: _Story card_ adds one and opens its side panel;
double-click or Enter on a selected story opens the panel again. Title and description are
edited live (every keystroke the smallest Y.Text edit, so concurrent typing merges); criteria
are added (Signal Forms), ticked, reworded and removed; the estimate is a deck-like value
(1-8 characters, no control or format characters). The card renders text only (S5.2).

```
block.text: Y.Text            title (≤ 200)
props: Y.Map
  description   Y.Text        ≤ 10 000 characters
  criteria      Y.Array<Y.Map { id, text: string (≤ 500), done: boolean }>   ≤ 50
  estimate      string | null
  pokerRoundId  string | null an id only, never a vote (S7.6)
```

`board.json` validates the props per field; `pokerRoundId` never comes along (it belongs to the
board it was started on).

## Planning poker

Contract 1.4.0 (`planning` tag), S7.6 and the M4 contract review. `BoardPoker` (one per open
board) and `PokerPoller` (one per round per tab) in `components/pages/boards/poker/`.

| Rule (contract / review)                                                  | Client                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start: signed-in EDITOR/OWNER                                             | dialog _Start estimating_ (title, Fibonacci / T-shirt / custom 2-20 values, distinct after NFC); the card gets `pokerRoundId` - an id only                    |
| Bind only when `round.storyBlockId` equals the card's id                  | the dialog polls the card's `pokerRoundId` (or the round the server lists for the card) and shows it only on a match; a mismatch stops the poller             |
| Poll `getPokerRound` every 2 s with `If-None-Match`; 304 = unchanged      | next poll 2 s after the answer (never overlapping), same tag after a 304; `ERRORS_HANDLED_LOCALLY`, so a 304/404 never toasts or opens an error page          |
| One poller per round per tab; stop when closed or not OPEN                | `BoardPoker.acquire/release` (reference-counted); stops on close, on REVEALED/CANCELLED, on 403/404; pauses while the tab is hidden, polls at once when shown |
| Back off on 429                                                           | waits `Retry-After`; other failures double the wait up to 30 s; the list (`listPokerRounds`) is throttled to one call per 5 s                                 |
| Keep the own vote from the 204 of `castPokerVote`                         | `myVote` = the vote this tab cast, else the server's; a cancelled round has none                                                                              |
| Everyone sees who voted, never what; names are text (`Deleted user` too)  | participants with "voted"/"thinking…" and a guest badge from `guest: true`                                                                                    |
| Reveal/cancel: facilitator while EDITOR, or the OWNER; never guests       | buttons only for them (`facilitatorId` = own id, or role OWNER)                                                                                               |
| After the reveal an editor writes the estimate and clears `pokerRoundId`  | result (average, median, distribution, suggestion preselected); _Save estimate_ / _Close without estimate_ = one document edit (`StoryModel.finishRound`)     |
| The canceller clears `pokerRoundId`                                       | done right after the cancel; other editors get _Detach the round from the card_                                                                               |
| Guests: COMMENTER/EDITOR links list OPEN, get, vote; VIEWER links nothing | `BoardPoker.access`: `none` makes no poker call at all; guests never see start, reveal or cancel                                                              |
| Error codes                                                               | `PLANNING_ROUND_ALREADY_OPEN` binds to `params.roundId`, `LIMIT_REACHED`, `CLOSED` (polls at once), `FULL`, `VALUE_INVALID`, 429 - each with its own text     |

How others learn about a round: the card's `pokerRoundId` changes in the document, which makes
every client list the OPEN rounds again; the board shows an **open rounds** pill (top centre)
and story cards with an open round an **Estimating** chip (both from the server's list, never
from `pokerRoundId` alone). Votes never touch the Y.Doc.

**Quick rounds** (contract 2.0.0, no `storyBlockId`): a fast estimate without a story card.
Editors and owners start one from the open rounds pill (_Start a quick round_; the pill shows
as _Estimations_ while nothing is open, for everyone with poker access). The same dialog runs in
quick mode: title prefilled "Quick round", no card binding, nothing written into the document;
after the reveal it shows the result and offers _New round_ (editors) and _Close_. A quick
dialog shows a round only when the server says it has no card (the binding rule the other way
round). The pill lists quick rounds with a _quick round_ badge; guests on COMMENTER/EDITOR links
open and vote in them as in card rounds. A quick round has no card to announce it, so others
find it by opening the pill, which lists the OPEN rounds again (throttled to one call per 5 s).
Polling, ETag, back-off and the own vote from the 204 are unchanged.

## Version history and restore

The owner lists the kept versions (`listBoardVersions`) and restores one after a confirmation.
The server then closes every session with **4410 "document replaced"**: the provider drops its
pending queue and stops, `BoardCollab` discards the Y.Doc, creates a fresh document, ticket and
provider, the canvas builds a new engine, a toast says "The board was restored to an earlier
version". The old state is never merged back.

## Backend, login, errors

| Concern    | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API client | `@apps/drawboard-api` (openapi-generator, typescript-angular). `provideApi('/api')` - relative, same origin; the image's nginx forwards `/api` to the backend. No backend URL in the bundle, no CORS.                                                                                                                                                                                                                                                               |
| Login      | **Any OIDC provider** (Keycloak by default, Authelia, ...). `oidc-client-ts` behind the abstract `Auth` (`services/auth.ts`: `authenticated`, `user`, `login()`, `logout()`, `token()`), implementation `OidcAuth`. Authorization code flow with PKCE (S256), `response_type=code` only. Issuer, client and scope come from `/config.json`.                                                                                                                         |
| Tokens     | **In memory only** (`InMemoryWebStorage` as user store). Only the short-lived login request (state, PKCE verifier) uses `sessionStorage`, because it must survive the redirect to the provider. A reload loses the tokens; the **silent sign-in** at startup (`prompt=none` in a hidden iframe, `public/silent-renew.html`) gets them back. No session at the provider means "not signed in" and `authGuard` starts the login with the requested URL as return URL. |
| Renewal    | On demand in `token()` (no timers): refresh token if the provider issued one, else a silent request. Concurrent callers share one renewal. `authInterceptor` adds the bearer token only to relative `/api/...` URLs.                                                                                                                                                                                                                                                |
| User       | `Auth.user` is loaded from `GET /api/users/me` (id, username, display name, admin). There are **no permission claims**: what a user may do with a board is `Board.role` from the API (UI hides what the role cannot do, the backend decides).                                                                                                                                                                                                                       |
| Errors     | `errorInterceptor` turns every failed `/api` call into an `ApiError` (problem+json). `ApiErrorHandler`: 401 -> login; violations a form shows itself -> nothing; everything else -> error toast with the **request id**; 403 / 404 on a read -> additionally the forbidden / not-found page. Texts per `ErrorCode` in `error-messages.ts`.                                                                                                                          |
| Conflicts  | Rename sends `Board.version`; on `409` the toast explains it and the list reloads.                                                                                                                                                                                                                                                                                                                                                                                  |
| Request id | **The browser never sends `X-Request-Id`.** With Faro the browser sends `traceparent`, so request id = trace id from the browser span down to SQL.                                                                                                                                                                                                                                                                                                                  |

## Runtime configuration

One image runs on dev and prod. Everything that differs comes from **`/config.json`**, which
the image's nginx renders from environment variables at container start
(`deploy/nginx/default.conf.template`); `main.ts` loads it before bootstrap. `ng serve` uses
the inline config of `environment.development.ts` instead.

| Variable                           | Default                                 | Meaning                                                                                                                                        |
| ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENVIRONMENT`                  | `unset`                                 | `local`, `dev`, `prod` - header badge (not on prod); `dev`/`prod` also add `upgrade-insecure-requests` to the CSP                              |
| `BACKEND_URL`                      | `http://drawboard-backend:18081`        | target of the `/api` proxy                                                                                                                     |
| `OIDC_ISSUER`                      | - (required)                            | issuer URL of the provider (`.../.well-known/openid-configuration` below it); its origin is added to the CSP                                   |
| `OIDC_CLIENT_ID`                   | `drawboard-web`                         | public SPA client (code flow + PKCE)                                                                                                           |
| `OIDC_SCOPE`                       | `openid profile email`                  | scopes requested at login                                                                                                                      |
| `FARO_RECEIVER_URL`                | - (Faro off)                            | Alloy `faro.receiver`, e.g. `http://192.0.2.4:12347`; set = Faro on                                                                          |
| `FARO_APP_NAME` / `FARO_NAMESPACE` | `drawboard-frontend` / `drawboard`      | `service.name` / `service.namespace`                                                                                                           |
| `FARO_SAMPLING_RATE`               | `1`                                     | share of page loads that send telemetry                                                                                                        |
| `APP_VERSION`                      | build argument                          | image version: footer, Faro release (source-map key)                                                                                           |
| `FILES_ORIGIN`                     | - (app origin)                          | own origin of the signed file URLs (= backend `DRAWBOARD_FILES_ORIGIN`): `/config.json` `filesOrigin`, CSP `img-src`/`media-src`/`connect-src` |
| `PLUGIN_ORIGIN`                    | - (app origin)                          | own origin of plugin assets and frames (= backend `DRAWBOARD_PLUGIN_ORIGIN`, S3.4): `/config.json` `pluginOrigin`, CSP `frame-src`             |
| `ABOUT_URL`                        | `https://drawboard.dergeorg.at`         | product site: "Host your own" in the footer, About dialog and guest line (`/config.json` `aboutUrl`); empty = promotion hidden                 |
| `SOURCE_URL`                       | `https://github.com/DerGeorg/drawboard` | where this instance offers its source (AGPL-3.0 section 13): footer and About dialog (`/config.json` `sourceUrl`); empty or invalid = default  |

`ABOUT_URL` and `SOURCE_URL` must be absolute `https://` URLs; the image bakes in the defaults
above. An invalid value falls back to the default (nginx passes only URL characters on). An
empty `ABOUT_URL` hides "Host your own"; an empty `SOURCE_URL` is the default again, because
the source link is the AGPL-3.0 offer: whoever runs a modified version sets it to their own
source.

`FILES_ORIGIN` and `PLUGIN_ORIGIN` must be a bare `scheme://host[:port]`; nginx ignores
anything else (it would end up in the CSP) and the app refuses to start with one. The backend
hands out file URLs as paths, so with a files origin the reverse proxy must route
`<files origin>/files/` to the backend too.

**The plugin origin is this container (S3.4).** With `PLUGIN_ORIGIN` set, the reverse proxy
routes the plugin host to the same port as the app, and nginx tells the two apart by the `Host`
header (the proxy host must pass it on unchanged). The plugin host serves `/plugin-assets/`
(GET) and nothing else: the app shell, `/config.json`, `/api`, `/files`, `/faro` and `/healthz`
are 404 there. The app host answers 404 for `/plugin-assets/`, so no plugin file is ever a
`'self'` script of the app. The 404s carry the app's security headers. A port in the origin is
part of the match (`http://localhost:8081`), a default port must not be written. With
`PLUGIN_ORIGIN` empty there is one origin and `/plugin-assets/` is served from it, as before.

The proxy host of the plugin origin must (Fable review "Plugin origin (S3.4) configured"):
pass the `Host` header unchanged (NPM does by default), have **no** access list or forward
auth (a redirect to the SSO would break the sandboxed module load), and point at **this
container** (port 18090), never at the backend - otherwise `/api` would be reachable on the
plugin origin. A `PLUGIN_ORIGIN` that is set but not a valid origin makes nginx refuse every
request, `/healthz` included: the container turns unhealthy instead of serving plugin files on
the app origin again.
`npm run check:headers` evaluates these rules on the template.

The provider must have the client registered with the **exact** values
`<origin>/auth/callback` (redirect) and `<origin>/` (post logout redirect), and
`<origin>/silent-renew.html` for the silent sign-in. Locally Keycloak's `drawboard-web` allows
`http://localhost:4200/*`.

On the servers the provider is Authelia (`https://sso.dergeorg.at`, public client `drawboard`,
scope `openid profile email groups offline_access`: renewal uses the refresh token, so the
hidden iframe is not needed). dev: Portainer stack `drawboard-frontend-dev` on note, port
18090, https://drawboard-dev.dergeorg.at; prod: `drawboard-frontend` on unraid, port 18090,
https://draw.dergeorg.at. Both are Portainer Git stacks of `deploy/compose.*.yaml` on
`main`; the NPM proxy host needs **Websockets Support** for the collaboration socket.

## Security headers and CSP (nginx image)

Set server-wide by `deploy/nginx/default.conf.template` (per-file differences are `map`s on
`$uri`, because nginx does not inherit `add_header` into a location that has its own):
`Content-Security-Policy` (default-src 'self', no inline scripts, `connect-src`/`frame-src`
allow the provider origin, `form-action 'self'`, enforced Trusted Types), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy: same-origin`, `Strict-Transport-Security`,
`Cache-Control: no-store` on `index.html` and `/config.json`, `server_tokens off`.

- `/silent-renew.html` is the only file that may be framed (by our own origin):
  `X-Frame-Options: SAMEORIGIN` and its own CSP (`default-src 'none'; script-src 'self';
frame-ancestors 'self'`). Its script is the external `/silent-renew.js` (no inline script).
- `frame-src` also contains `'self'`: the silent iframe is redirected by the provider back to
  `/silent-renew.html`, and CSP checks every redirect target.
- The production build does not inline critical CSS (`optimization.styles.inlineCritical:
false` in `angular.json`): that feature adds an inline `<script>` that the CSP would block.
- `/api` and `/faro` get request headers from an **allowlist** (`proxy_pass_request_headers
off`): the cookies of the web host never reach the API. The app never sends
  `Access-Control-Allow-Origin` (and drops it from upstream answers): one origin, no CORS.
- **`/files/`** and **`/plugin-assets/`** go to the backend (GET only, request headers from an
  allowlist, `Range`/`If-Range` in and `Accept-Ranges`/`Content-Range`/`Content-Disposition`
  out, `proxy_buffering off`) and get **no CSP, X-Frame-Options or Cache-Control from nginx**:
  the backend sends its own (the sandbox CSP of files, S4.5; the frame CSP with
  `frame-ancestors`, S3.3). `/files/` has `limit_conn` (50 per address, 400 in total -
  behind the reverse proxy the address is the proxy's) and an **access log without query
  string** and an error log at `crit` only (nginx's error lines quote the request line, S7.2).
- Uploads: `client_max_body_size 500m` and `proxy_request_buffering off` on
  `/api/boards/*/files`, `21m` on `/api/admin/plugins` (the container's `/tmp` is a 16 MB
  tmpfs, nothing is spooled).
- CSP additions: `img-src`, `media-src` and `connect-src` name the files origin, `frame-src` the
  plugin origin (both empty by default; `'self'` covers the app origin). No external embeds
  exist (S5.4: the embed allowlist is empty, so off).
- **Checked** by `npm run check:headers` (`scripts/check-headers.mjs`, also the Playwright spec
  `e2e/headers/`): every CSP directive against S7.5 (no `'unsafe-eval'`, no inline scripts,
  no bare `wss:`, `frame-ancestors 'none'`, `upgrade-insecure-requests` on dev/prod), nosniff,
  Referrer-Policy, X-Frame-Options DENY, Permissions-Policy, COOP, HSTS, Cache-Control,
  `server_tokens off`, `always` everywhere, nosniff repeated in locations with own headers, no
  CORS on `/api`, no query string in the `/files/` log. Unknown CSP directives are errors (except
  the two Trusted Types ones, which are validated); `script-src-elem`, `script-src-attr` and
  `child-src` have rules; script directives, `object-src` and `base-uri` refuse
  `'unsafe-inline'`, `'unsafe-hashes'`, `data:` and `blob:`; every entry of the CSP map is
  checked; `form-action` must be `'self'` (`frame-src` keeps the OIDC origin, decided in the M4
  review); dotted paths must not reach the SPA fallback; `.mjs` must be JavaScript.
- **Dotted paths:** `location ~ /[^/]*\.[^/]*$ { try_files $uri =404; }` before `location /`:
  `/.env` is a 404 (with the security headers), `/boards/<uuid>` still gets the shell. Regex
  locations beat prefix ones, so `/api/`, `/files/`, `/plugin-assets/` and `/faro/` are `^~`.
- **Trusted Types** (S3.12, decided in the M4 review) are enforced: `require-trusted-types-for
'script'; trusted-types angular dompurify drawboard default`. `src/trusted-types.ts` is the
  first import of `main.ts`: policy `default` answers `createHTML` only while a Mermaid render
  runs (`duringMermaidRender`), only for the `Element innerHTML` sink and only for text
  without `<` (Mermaid's `<style>`), and throws for scripts and script URLs; policy `drawboard`
  allows exactly `/pdfjs/pdf.worker.min.mjs` of our own origin, which `pdf-view.ts` starts as a
  module `Worker` and hands to pdf.js as `workerPort` (one shared worker, terminated with the
  board page). A `securitypolicyviolation` listener (`util/csp-violation.ts`, started with Faro)
  sends directive, disposition and the origin of `blockedURI` as the Faro event
  `csp_violation` - never `sample`, never a full URL. Proven by the `sandbox` and `mocked`
  Playwright projects under the header read from the template: zero violations for Mermaid
  (also with `%%{init}%%`), two PDFs with the worker, a plugin block, a kanban and a story card.
- Telemetry never carries a query string or fragment: `scrubTransportItem` (`services/faro.ts`)
  walks every Faro item and cuts URLs to origin + path (share-link tokens and data-URL
  contents will live in the fragment). Router events are reported by route template only.

## Observability (Grafana Faro) and deep tracing

As in the reference app: `services/faro.ts` starts the Faro Web SDK (lazy chunks, sampled page
loads only, storage-free) when `FARO_RECEIVER_URL` is set; the browser posts same-origin to
`/faro/collect`. `@WithSpan('<Class>.<method>')` on `*Actions` methods and page handlers puts
the Angular side above Faro's fetch span ("BoardCreate.submit > BoardActions.create > POST >
backend"); route changes are `navigation /boards/:boardId` spans. Details: skill
`web-frontend`, `references/observability.md`.

## Local development

Node **>= 24.15** (Angular CLI 22), e.g. `nvm use 24.20`. The registry token (for `@ci/*`):

```bash
export NPM_TOKEN=<personal access token, scope read_api>
npm ci
```

`@apps/drawboard-api` (the generated client of `apps/drawboard/api`) comes from the same
registry; its version is in `package.json`. Without a token install a locally built package:
`npm install --no-save <api>/build/npm/apps-drawboard-api-<version>.tgz` (again after every
`npm ci`). With such a package installed, a plain `npm install <pkg>` tries to restore the
locked `@apps/drawboard-api` from the registry (401 without token): add the dependency with
`npm install <pkg> --package-lock-only`, then run the `--no-save` install again.

Backend stack (`../backend`): Postgres + Keycloak (18180, realm `drawboard`, public client
`drawboard-web`, users `alice` and `bob`), backend on **18081**.

```bash
npm start                  # ng serve on http://localhost:4200, /api -> 18081, /faro -> 12347
npm test                   # Vitest (watch); npm run test:ci = once, with coverage + JUnit
npm run lint               # ESLint (src + e2e) - house rules from @ci/eslint-plugin
npm run format:check       # Prettier (npm run format writes)
npm run build              # production build -> dist/drawboard-frontend/browser
```

### Run the image locally

There is no Dockerfile in this repository: the pipeline's `angular-image` generates it (nginx
with `deploy/nginx/default.conf.template`, defaults of `runtime-env` in `.gitlab-ci.yml`).

```bash
docker run --rm -p 18090:8080 \
  -e APP_ENVIRONMENT=local \
  -e BACKEND_URL=http://host.docker.internal:18081 \
  -e OIDC_ISSUER=http://localhost:18180/realms/drawboard \
  registry.dergeorg.at/apps/drawboard/frontend:<version>
```

## Tests

- **Unit/component tests** (Vitest 5 in jsdom, plain TestBed, zoneless): one spec per component,
  service, guard and helper; names `when ... [given ...] then ...`, a message on **every**
  `expect`. HTTP through `HttpTestingController` with the app's real interceptors
  (`test/http-testing.ts`), auth through `FakeAuth`, the OIDC library through `FakeOidcClient`.
  Coverage thresholds: statements/lines/functions 80 %, branches 70 % (`angular.json`).
- **End-to-end tests** (Playwright, `e2e/`) against the built image on 18090 (or
  `E2E_BASE_URL=http://localhost:4200`) plus the backend stack: `auth.setup.ts` logs alice and
  bob in through the real provider page once; boards are seeded and removed through the backend
  API; `e2e/tracing/` checks the span chains.

  ```bash
  npx playwright install chromium          # once
  npm run e2e
  npx playwright test --project=sandbox    # no backend, no login: see below
  E2E_BASE_URL=http://localhost:4200 npx playwright test --project=mocked   # app, mocked API
  ```

- **Sandbox and content tests** (Playwright project `sandbox`, `e2e/plugins/`, `e2e/content/`):
  they serve everything themselves and need neither backend nor login. `sandbox.spec.ts` runs
  the real plugin host with a **hostile plugin** behind the backend's frame CSP: no cookie,
  storage, parent document or URL, no popup, no top navigation, no fetch to `/api` or anywhere
  else, a spoofed window message and requests without grants change nothing. `content.spec.ts`
  renders a Mermaid diagram (with an `%%{init}%%` attack), two PDFs, a kanban and a story card
  under the production CSP with enforced Trusted Types (the header is read from the nginx
  template): not one `securitypolicyviolation`, no eval, no `foreignObject`. `restless.spec.ts`: a plugin that sends a 10 MB
  message and then navigates its own frame - the board keeps running, the message gets no
  answer, the frame gets no second port and the plugin stops on the board. `e2e/headers/`
  checks the nginx template (see _Security headers_) and proves the check catches weakened
  headers.
- **Mocked-API tests** (project `mocked`, `e2e/guests/`): the served app (image or `ng serve`)
  without backend or login, every `/api` call answered by `page.route`. Guests on edit,
  comment and view links: every call the UI makes is on the guest allowlist (S1.8 with the M4
  poker additions); a guest votes but never creates, reveals or cancels a round; a VIEWER-link
  guest makes no poker call at all. `trusted-types.spec.ts` adds diagrams, a kanban and a story
  card to the real app under the enforced header (the image sends it; `ng serve` gets it from
  the spec) and expects zero violations. `kanban-drag.spec.ts` drives the kanban with real pointer
  events and keys (drag between columns, Alt+arrow, drag out onto the canvas, undo). `zoom-out.spec.ts`
  serves a board of 5000 blocks through a **mocked collaboration socket**
  (`e2e/support/collab-socket.ts`: `page.routeWebSocket` speaks `drawboard.v1`, WELCOME,
  SNAPSHOT, SYNCED, and plays other participants' AWARENESS and PEER_LEFT frames), zooms to 2 %,
  checks that only plain boxes are in the DOM and attaches the measured step times to the report
  (never asserted). `follow.spec.ts` plays Bob and others through that socket: follow,
  tracking, Esc, leaving, a summon with Stop, cooldown and end, and summons that must change
  nothing (from a guest, 51 targets, a bad viewport, payload text).

## TODO

- **Follow and present:** the awareness fields (`viewport`, `following`, `summon`) and the
  receiver rules need the Fable security review before production (architecture section 8);
  `api/docs/collab-protocol.md` and `docs/board-engine.md` (zoom range, awareness state) still
  describe the old state. A user with a direct VIEWER grant who is also in an EDITOR group is
  refused as a summoner (the member list cannot tell). The presenter's view size is not sent,
  so a follower on a smaller screen sees less around the same centre.
- **Contract 1.4.0:** `package.json` still names `@apps/drawboard-api` 1.2.0; M3 and M4 are
  built and tested against a local build of 1.4.0 (`--no-save`). Bump once 1.4.0 is released.
- **Plugins, export/import:** `export.register`/`import.register` need the service instance
  (one hidden frame per plugin and board) and the export/import menus - not built in M3.
- **Plugins in `.drawboard` files:** import refuses plugin block types (no per-type schema);
  deciding how to validate them is a security question for the next review.
- **S3.10 latency:** other open boards learn that a plugin was disabled within a minute (or
  when the tab is shown again); a push would need a server event.
- **SDK package:** publish `src/plugin-sdk` as `@apps/drawboard-plugin-sdk` (own build and
  pipeline job); add service-instance support to it with the export/import work.
- **Mermaid:** per-block export (`.mmd`, SVG, PNG) and the 12.x line once it no longer needs
  `elkjs` (or with that dependency excluded); tell Renovate to stay on 11.
- **Sandbox and mocked tests in the pipeline:** the `sandbox` and `mocked` projects need no
  backend and can run in CI before `angular-e2e` exists (`mocked` needs the built image or
  `ng serve`).
- **M4 security review:** the kanban stores the assignee as a display name only (no user id in
  the document guests can read). Trusted Types are enforced in the image; before third-party
  plugins are enabled in production the header must be seen working on dev.
- **Kanban:** WIP limits, card descriptions and filtering by assignee or label are not built;
  a card's edits made while someone deletes its column end up in the first column.
- **Story/poker:** no context-toolbar button for _Planning poker_ (the story panel, the chip on
  the card and the open-rounds pill open it); a story card has no colour or size presets.

- **`angular-e2e`:** not in `.gitlab-ci.yml` yet (the e2e tests have never run against a
  backend image); add it with a pinned backend image and the realm of the backend repository.
- **Login failure loop:** if the provider keeps answering the callback with an error, the guard
  starts the login again; add a "login failed" page when this shows up in practice.
- **Faro on dev/prod:** set `FARO_RECEIVER_URL` in `deploy/compose.*.yaml` once Alloy has its
  `faro.receiver`.
