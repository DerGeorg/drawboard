# Plugin protocol (plugin API 1.0.0)

The part of the contract that third-party plugins code against: the plugin
package and its manifest `drawboard-plugin.json`, how the board host loads a
plugin into a sandboxed frame, and the messages host and plugin exchange over
a `MessageChannel`. OpenAPI cannot describe it, so it lives here, next to the
REST contract it belongs to (installing and managing plugins: tag `plugins`
in `openapi.yaml`). The frontend (board host) and the backend (module
`plugins`: install checks, asset delivery, storage) implement exactly this.

Security requirements quoted as S3.n come from the security review
(`docs/architecture.md` of the app, section "Security decisions").

## Versions

* **Plugin API version** - this document, Semantic Versioning: currently
  **1.0.0**. A minor version adds message types, capabilities or optional
  fields; a change an old plugin cannot handle is a new major version.
* `v` in every message is the **major** version (`1`).
* `minHostVersion` in the manifest is the lowest plugin API version the plugin
  needs. The server refuses to install a plugin whose `minHostVersion` is
  newer than the plugin API version it implements (400
  `PLUGINS_MANIFEST_INVALID`, violation on `minHostVersion`).
* Both sides ignore fields they do not know. The host drops message types it
  does not know (see Validation); a plugin should do the same.

The version of the REST contract package (`@apps/drawboard-api`) is
independent of the plugin API version.

## Trust model in one paragraph

Plugins installed at runtime **always** run in a sandboxed iframe
(`sandbox="allow-scripts"`, opaque origin) and can do nothing but compute,
render inside their frame, talk to the host over their `MessagePort`, and -
only with the `network` capability - connect to the granted hosts. They never
get a token, never call `/api`, never touch the board's DOM, never see other
boards, email addresses or real user ids, and cannot upload files (S3.1, S3.2,
S3.8). Every capability is off until an instance admin grants it
(`updatePlugin`). Built-in blocks (`core.*`) are not plugins in this sense:
they are part of the frontend image.

## Package

A plugin is uploaded as **one ZIP** (`installPlugin`, S3.9):

| Rule | Limit |
|---|---|
| ZIP size | ≤ 20 MB |
| Entries | ≤ 200 |
| Unpacked size (counted while unpacking) | ≤ 50 MB |
| Paths | relative, `/` separated, no `..` segment, no leading `/` or `\`, no drive letters, no symbolic or hard links, no duplicates (case-insensitive), ≤ 255 characters, `[A-Za-z0-9._/-]` only |
| Reserved | every path starting with `__drawboard` (`__drawboard/` holds the generated frame document) |
| File types (by extension) | `.js`, `.mjs`, `.css`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.woff2`, `.txt`, `.md`; directories. No `.wasm` in plugin API 1 (the frame CSP has no `'wasm-unsafe-eval'`). **No `.html`, no `.svg`**, nothing else |
| Manifest | `drawboard-plugin.json` at the root |
| Entry | the file named by `entry` exists and is `.js` or `.mjs` |

Violations answer 400 `PLUGINS_ARCHIVE_INVALID` with `params.reason`
(`NOT_A_ZIP`, `TOO_MANY_ENTRIES`, `UNPACKED_TOO_LARGE`, `UNSAFE_PATH`,
`FILE_TYPE_NOT_ALLOWED`, `MANIFEST_MISSING`, `ENTRY_MISSING`) and
`params.path` where an entry is to blame; a ZIP over 20 MB answers 413.

After install every file is served unchanged below the plugin's immutable
`assetBase` (`/plugin-assets/<id>/<version>/<sha256 of the ZIP>/`, S3.5) with
a media type derived from the extension, `X-Content-Type-Options: nosniff`,
`Cache-Control: public, max-age=31536000, immutable` and
`Access-Control-Allow-Origin: *` without credentials. A request is resolved
against the list of entries stored at install (exact path match), never by
joining the URL path onto a directory; any other path answers 404. Bundles
must not contain secrets: everything in them is public.

## Manifest `drawboard-plugin.json`

```json
{
  "manifestVersion": 1,
  "id": "org.example.timer",
  "name": "Timer",
  "version": "1.2.0",
  "description": "A countdown block for workshops.",
  "entry": "dist/index.js",
  "minHostVersion": "1.0.0",
  "blockTypes": [
    { "type": "org.example.timer.countdown", "label": "Countdown", "defaultWidth": 240, "defaultHeight": 120 }
  ],
  "capabilities": [
    { "name": "block.props" },
    { "name": "block.resize" },
    { "name": "storage" },
    { "name": "network", "value": "time.example.org" }
  ]
}
```

| Field | Rules |
|---|---|
| `manifestVersion` | required, `1` |
| `id` | required, 3–100 characters, `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$` (reverse-DNS-like, at least two segments); not `core` or `drawboard` as first segment. The namespace of all its block types; it identifies the plugin across versions |
| `name` | required, 1–100 characters, plain text |
| `version` | required, Semantic Versioning 2.0.0, ≤ 64 characters. An upload with a higher version of an installed `id` is an upgrade; the same or a lower one is refused (409 `PLUGINS_VERSION_EXISTS`) |
| `description` | optional, ≤ 1000 characters, plain text |
| `entry` | required, path of the ES module inside the ZIP (`.js`/`.mjs`), ≤ 255 characters |
| `minHostVersion` | required, Semantic Versioning, the lowest plugin API version the plugin needs |
| `blockTypes` | optional (default `[]`), ≤ 50 entries, `type` unique |
| `blockTypes[].type` | `<id>.<name>` - starts with the plugin's `id` and a dot, ≤ 150 characters, same character rules as `id` |
| `blockTypes[].label` | 1–100 characters, plain text (toolbar) |
| `blockTypes[].defaultWidth`, `defaultHeight` | integers 16–4096, board units |
| `capabilities` | optional (default `[]`), ≤ 30 entries, no duplicates (name + value) |
| `capabilities[].name` | one of the capabilities below |
| `capabilities[].value` | only for `import.register` (one media type `type/subtype`, ≤ 100 characters; one entry per type) and `network` (space-separated list of at most 10 host names: https only, port 443 unless an explicit `:port` is given, at least two labels, last label not `local`, `lan`, `internal`, `localhost`, `home` or `arpa`, no wildcards, no IP literals); absent for every other capability. The admin UI shows the hosts before granting `network` |

No other fields are allowed. Strings are plain text: the host never
interprets them as HTML. Violations answer 400 `PLUGINS_MANIFEST_INVALID` with
one `violations` entry per problem, `field` being the JSON path
(`blockTypes[0].type`).

JSON Schema (draft 2020-12) the server validates with:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "drawboard-plugin.json (plugin API 1)",
  "type": "object",
  "additionalProperties": false,
  "required": ["manifestVersion", "id", "name", "version", "entry", "minHostVersion"],
  "properties": {
    "manifestVersion": { "const": 1 },
    "id": { "type": "string", "minLength": 3, "maxLength": 100, "pattern": "^(?!(core|drawboard)\\.)[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$" },
    "name": { "type": "string", "minLength": 1, "maxLength": 100 },
    "version": { "$ref": "#/$defs/semver" },
    "description": { "type": "string", "maxLength": 1000 },
    "entry": { "type": "string", "maxLength": 255, "pattern": "^(?!/)(?!.*(^|/)\\.\\.(/|$))[A-Za-z0-9._/-]+\\.m?js$" },
    "minHostVersion": { "$ref": "#/$defs/semver" },
    "blockTypes": {
      "type": "array", "maxItems": 50,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["type", "label", "defaultWidth", "defaultHeight"],
        "properties": {
          "type": { "type": "string", "maxLength": 150, "pattern": "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$" },
          "label": { "type": "string", "minLength": 1, "maxLength": 100 },
          "defaultWidth": { "type": "integer", "minimum": 16, "maximum": 4096 },
          "defaultHeight": { "type": "integer", "minimum": 16, "maximum": 4096 }
        }
      }
    },
    "capabilities": {
      "type": "array", "maxItems": 30,
      "items": {
        "type": "object", "additionalProperties": false,
        "required": ["name"],
        "properties": {
          "name": { "enum": ["block.props", "block.resize", "board.read", "export.register", "import.register", "ui.toast", "ui.openLink", "storage", "network"] },
          "value": { "type": "string", "minLength": 1, "maxLength": 1000 }
        }
      }
    }
  },
  "$defs": {
    "semver": {
      "type": "string", "maxLength": 64,
      "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
    }
  }
}
```

Checks the schema cannot express, done by the server as well: every
`blockTypes[].type` starts with `id + "."`; `value` present exactly for
`import.register` and `network` and well-formed for them; no duplicate
capabilities or block types; `minHostVersion` ≤ the implemented plugin API
version.

## Capabilities

Declared in the manifest, granted by the admin, default off (S3.8). Requests
for a capability that is not granted answer the error `CAPABILITY_NOT_GRANTED`.

| Capability | Gives the plugin |
|---|---|
| `block.props` | `block.setProps`: write the props of **its own** block (types `<id>.*` only) |
| `block.resize` | `block.resize`: resize its own block |
| `board.read` | `board.read`: structure and text of the current board - no email addresses, no user ids, no props of other plugins' or built-in blocks |
| `export.register` | `export.register` and answering `export.run`: an entry in the board's export menu |
| `import.register` + media type | `import.register` and answering `import.run` for exactly that media type |
| `ui.toast` | `ui.toast`: a short plain-text notification |
| `ui.openLink` | `ui.openLink`: the host asks the user, showing the target host, then opens the link with `noopener` |
| `storage` | `storage.get`, `storage.set`, `storage.keys`: key-value store per plugin and board, ≤ 1 MB in total |
| `network` + hosts | no messages: the granted hosts become `connect-src` of the plugin's frame (S3.3) as `https://<host>[:port]`; requests carry no user credentials |

Without any capability a plugin can still render its block from the props
and size the host sends.

## Loading (host side)

1. The host reads the enabled plugins (`GET /api/plugins`,
   `listEnabledPlugins`) when a board opens.
2. For every visible block of a plugin type (at most 50 plugin frames at
   once, only in the viewport, S3.2) the host creates a **block instance**:

   ```html
   <iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer"
           loading="lazy" src="<assetBase>__drawboard/frame.html"></iframe>
   ```

   For a plugin with `export.register` or `import.register` granted, the host
   also creates one hidden **service instance** per open board (same frame,
   no block), which registers formats and answers export/import runs.
3. `frame.html` is generated by the server (S3.6), not taken from the ZIP. It
   is served with `X-Content-Type-Options: nosniff` and this CSP (S3.3, as
   refined by the M3 contract review):

   ```
   sandbox allow-scripts;
   default-src 'none';
   script-src <scheme://host><assetBase>;
   style-src <scheme://host><assetBase> 'unsafe-inline';
   img-src <scheme://host><assetBase> data: blob:;
   font-src <scheme://host><assetBase>;
   connect-src <granted network hosts as https://host[:port], else 'none'>;
   base-uri 'none';
   form-action 'none';
   frame-ancestors <app origin>
   ```

   `<scheme://host>` is the origin the assets are served from (the plugin
   origin, else the app origin). Inside the sandbox the frame's origin is
   opaque, so `'self'` would match nothing: every source is explicit and
   **path-scoped** to this plugin's own `assetBase` (ending in `/`), so the
   frame cannot load another plugin's or the app's scripts. There is no
   `'wasm-unsafe-eval'`: WebAssembly is not part of plugin API 1. The
   document contains nothing but the plugin's entry module:

   ```html
   <!doctype html><meta charset="utf-8">
   <script type="module" src="<entry>" integrity="sha384-..." crossorigin="anonymous"></script>
   ```

   with `integrity` = `EnabledPlugin.integrity`, computed at install.
4. On the iframe's `load` event the host creates a `MessageChannel` and
   transfers one port:

   ```js
   iframe.contentWindow.postMessage({ type: 'connect', v: 1 }, '*', [channel.port2]);
   ```

   (`'*'` because the sandboxed frame has an opaque origin; the message
   carries no data besides the port.) From then on the host uses only
   `channel.port1`, never `window.postMessage` again, and ignores every
   message the frame posts to the window.
5. The host sends `init` over the port. The plugin answers `ready` within
   10 s, else the host replaces the frame by a "plugin did not start"
   placeholder.

One `MessageChannel` per instance (S3.7). Disabling or removing a plugin
removes all its frames at once (S3.10); a block whose plugin is missing,
disabled or failed renders as a placeholder that keeps its data, with a badge
"Plugin: <id>" (S3.11).

## Connecting (plugin side)

The entry module listens for the connect message, accepts the **first**
`message` event whose `source` is `window.parent`, whose `data` is
`{type: 'connect', v: 1}` and that carries exactly one port, and ignores every
later window message. The SDK (`@apps/drawboard-plugin-sdk`) does this; a
plugin without the SDK:

```js
window.addEventListener('message', function onConnect(event) {
  if (event.source !== window.parent || event.data?.type !== 'connect' || event.ports.length !== 1) return;
  window.removeEventListener('message', onConnect);
  const port = event.ports[0];
  port.onmessage = (e) => handle(e.data);   // init, events, replies
  port.start();
});
```

## Messages

### Envelope

Every message in both directions is one plain JSON-compatible object (no
`Blob`, `ArrayBuffer`, `Date`, functions or transferred objects) with exactly
these members:

```json
{ "type": "block.resize", "v": 1, "requestId": "p-17", "payload": { "width": 320, "height": 200 } }
```

| Member | Rules |
|---|---|
| `type` | required, 1–64 characters, `^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$` |
| `v` | required, the major plugin API version: `1` |
| `requestId` | only on requests and their replies, 1–64 characters `[A-Za-z0-9_-]`, unique among the sender's pending requests. The host's own requests start with `h-` |
| `payload` | required, an object (`{}` when there is nothing to say) |

Three kinds:

* **request** - carries `requestId`; the receiver answers exactly once with
  `<type>.result` (success, same `requestId`) or `error` (same `requestId`).
* **reply** - `<type>.result` or `error`, with the `requestId` of the request.
* **event** - no `requestId`, no answer.

### Validation and limits (S3.7)

The host validates every message from the plugin against the envelope and the
payload schema of its type:

| Case | Reaction |
|---|---|
| Not an object, wrong members, wrong `v`, unknown `type` | dropped, counted, no reply |
| Known type, invalid payload | `error` `INVALID_PAYLOAD` (if it is a request), counted |
| Larger than 256 KiB (UTF-8 bytes of its JSON) | dropped, counted |
| More than 100 messages per second per instance (token bucket, burst 100) | excess dropped, counted |
| More than 32 pending requests of the instance | `error` `TOO_MANY_REQUESTS` |
| More than 500 dropped messages within one minute | the host terminates the instance (frame removed, "plugin stopped" placeholder until the board is reloaded) |

The host never executes strings from a plugin and never assigns plugin data
to `innerHTML`; text from a plugin is rendered as text. The host answers every
valid request within 10 s (else `TIMEOUT`); a plugin answers host requests
(`export.run`, `import.run`) within 30 s, else the host treats the run as
failed.

### Errors

```json
{ "type": "error", "v": 1, "requestId": "p-17", "payload": { "code": "CAPABILITY_NOT_GRANTED", "message": "block.resize is not granted" } }
```

| `code` | Meaning |
|---|---|
| `INVALID_PAYLOAD` | the payload does not match the schema of the type |
| `CAPABILITY_NOT_GRANTED` | the capability behind the type is not granted (or, for `import.register`, not for this media type) |
| `NOT_ALLOWED` | granted, but not now: the board is in view mode, the user's role does not allow it (a viewer writing props or storage, a guest writing storage), not a block instance, or a block type of another plugin |
| `TOO_LARGE` | a size limit of the type was exceeded |
| `TOO_MANY_REQUESTS` | too many pending requests, or the server rate-limited the host's call |
| `CONFLICT` | the storage changed concurrently and the host gave up after 3 attempts |
| `NOT_FOUND` | the thing referred to does not exist (a block, a format id) |
| `CANCELLED` | the user declined (`ui.openLink`) |
| `UNAVAILABLE` | the host could not reach the server or the server failed |
| `TIMEOUT` | no answer in time |

`message` is English text for developers, ≤ 500 characters. Plugins switch
on `code` and must tolerate codes they do not know.

### Lifecycle

| Type | Direction | Kind | Payload |
|---|---|---|---|
| `init` | host → plugin | event | see below; the first message on the port |
| `ready` | plugin → host | event | `{}` - the plugin has rendered; the host shows the frame |
| `block.changed` | host → plugin | event | `{props?, width?, height?}` - the block changed (another user, undo, a resize by the user); only the changed members |
| `mode.changed` | host → plugin | event | `{mode}` |
| `theme.changed` | host → plugin | event | `{theme}` |
| `destroy` | host → plugin | event | `{}` - the frame is removed about 1 s later; persist nothing here |

`init` payload:

```json
{
  "apiVersion": "1.0.0",
  "instance": "block",
  "plugin": { "id": "org.example.timer", "version": "1.2.0" },
  "block": { "id": "3f0c…", "type": "org.example.timer.countdown", "width": 240, "height": 120, "props": { "seconds": 300 } },
  "board": { "id": "0192f5e0-…" },
  "mode": "edit",
  "role": "EDITOR",
  "user": { "id": "u3vJk…43 characters", "name": "Alice", "guest": false },
  "locale": "de-AT",
  "theme": { "colorScheme": "light" },
  "capabilities": [ { "name": "block.props" }, { "name": "storage" } ],
  "limits": { "messageBytes": 262144, "messagesPerSecond": 100, "propsBytes": 65536, "storageBytes": 1048576 }
}
```

* `instance`: `block` or `service`; `block` is absent for a service instance.
* `mode`: `view` (read only: presenting, viewer role, guest viewer) or
  `edit`.
* `role`: the user's role on the board (`OWNER`, `EDITOR`, `COMMENTER`,
  `VIEWER`).
* `user.id` is `EnabledPlugin.userPseudonym`, the pseudonymous id for this
  plugin (S3.8) - never the real user id. `user.name` is the display name;
  `guest` marks a guest.
* `capabilities` are the granted ones.

### Capability messages (plugin → host requests)

| Type | Capability | Payload | Result payload |
|---|---|---|---|
| `block.setProps` | `block.props` | `{props: object}` - the complete new props of the instance's own block; JSON ≤ 64 KiB; JSON values only | `{}` |
| `block.resize` | `block.resize` | `{width, height}` - integers 16–4096 | `{width, height}` as applied |
| `board.read` | `board.read` | `{cursor?: string}` | `{board: {id, title}, blocks: [Block], connectors: [Connector], nextCursor?}` - at most 500 blocks per page; call again with `nextCursor` until it is absent |
| `export.register` | `export.register` | `{formats: [{id, label, mediaType, extension}]}` - service instance only, ≤ 5 formats, `id` `[a-z0-9-]{1,32}` | `{}` |
| `import.register` | `import.register` (that media type) | `{mediaType, label, extensions: [".csv"]}` - service instance only | `{}` |
| `ui.toast` | `ui.toast` | `{level: "info"\|"success"\|"warning"\|"error", message}` - plain text, ≤ 200 characters | `{}` |
| `ui.openLink` | `ui.openLink` | `{url}` - `https:` or `http:`, ≤ 2048 characters | `{opened: true}`; the user declining answers `CANCELLED` |
| `storage.get` | `storage` | `{key}` | `{value}` - `null` when the key is not set |
| `storage.set` | `storage` | `{key, value}` - `value` any JSON value ≤ 200 KiB, `null` deletes the key | `{}` |
| `storage.keys` | `storage` | `{}` | `{keys: [string]}` |

* `block.setProps` and `block.resize` need `mode: edit` and the role `EDITOR`
  or `OWNER`, else `NOT_ALLOWED`. The host writes the props into the block's
  `props` map (keys absent from `props` are removed) in one transaction; the
  change reaches the other participants through the normal collaboration
  traffic and comes back to their instances as `block.changed`.
* `Block` in `board.read`: `{id, type, x, y, width, height, rotation,
  parentId?, text?, props?}` - `text` is the plain text of the block, `props`
  only for block types of this plugin. `Connector`: `{id, from, to, label?}`
  with `from`/`to` = `{blockId}` or `{x, y}`. No author information, no
  awareness data.
* Storage keys: 1–128 characters `[A-Za-z0-9._:-]`. The host implements the
  store over `GET`/`PUT /api/boards/{boardId}/plugin-storage/{pluginId}`
  (getPluginStorage, putPluginStorage: one JSON object per plugin and board,
  key = member). A write is read-modify-write with the object's `version`;
  the host retries a 409 up to 3 times, then answers `CONFLICT`. The whole
  object is ≤ 1 MB (server 413 → `TOO_LARGE`). Reading needs the role
  `VIEWER` (guests may read), writing `EDITOR` or `OWNER` and a signed-in
  user (else `NOT_ALLOWED`). The plugin frame never calls the API itself: it
  has no token, and `/api` is not in its `connect-src`.

### Export and import (host → plugin requests)

Export, after the user picked a plugin format in the export menu:

1. host → service instance, request `export.run`:
   `{formatId, scope: "board"|"selection", selection?: [blockId]}`.
   The plugin reads the board with `board.read` (it needs that capability
   too).
2. plugin → host, zero or more events `export.chunk`:
   `{exportId: <the request's requestId>, index: 0.., data: string}`, each
   message ≤ 256 KiB.
3. plugin → host, reply `export.run.result`:
   `{fileName, mediaType, encoding: "utf8"|"base64", chunks: <count>}`.
   The host joins the chunks (at most 20 MB in total) and offers the file as a
   download. `fileName` is sanitised by the host (path separators and control
   characters removed, at most 255 characters); the extension and the media
   type of the download are always those of the registered format, never
   taken from the reply (a different `mediaType` fails the run).

Import, after the user dropped or picked a file of a registered media type
(at most 20 MB; the host checks the extension and the declared type, the
plugin must not trust the content):

1. host → service instance, events `import.chunk`:
   `{importId, index: 0.., data: string}` (base64, each message ≤ 256 KiB).
2. host → service instance, request `import.run`:
   `{importId, fileName, mediaType, size, chunks: <count>}`.
3. plugin → host, reply `import.run.result`: `{blocks: [NewBlock]}` with at
   most 2000 entries, `NewBlock` = `{type, x, y, width, height, props?,
   text?}`; `type` is one of the plugin's own types or `core.sticky`,
   `core.text`, `core.shape`; `x`/`y` relative to the drop point. The host
   validates every block (finite coordinates, sizes 16–4096, props ≤ 64 KiB,
   text ≤ 100 000 characters, props of `core.*` types against their own
   schema) and inserts them as one undo step; an invalid block fails the
   whole import with a toast.

## Limits

| What | Limit | Reaction |
|---|---|---|
| Message | 256 KiB (UTF-8 bytes of its JSON) | dropped, counted |
| Messages from the plugin per instance | 100/s, burst 100 | excess dropped, counted |
| Pending plugin requests per instance | 32 | `TOO_MANY_REQUESTS` |
| Dropped messages per instance | 500 per minute | instance terminated |
| Plugin frames at once per board | 50, viewport only | others render a static placeholder |
| `ready` after `init` | 10 s | "plugin did not start" placeholder |
| Host answer to a request | 10 s | `TIMEOUT` |
| Plugin answer to `export.run`/`import.run` | 30 s | run failed, toast |
| Props per block | 64 KiB | `TOO_LARGE` |
| Storage per plugin and board | 1 MB in total, 200 KiB per value | `TOO_LARGE` |
| Export / import file | 20 MB | `TOO_LARGE` / refused by the host |
| Imported blocks per run | 2000 | run failed |
| `ui.toast` text | 200 characters | `INVALID_PAYLOAD` |

## Example

```
host:   (creates the frame, on load) window.postMessage({type:'connect', v:1}, '*', [port2])
host:   {"type":"init","v":1,"payload":{"apiVersion":"1.0.0","instance":"block","block":{"id":"3f0c…","type":"org.example.timer.countdown","width":240,"height":120,"props":{"seconds":300}},…}}
plugin: {"type":"ready","v":1,"payload":{}}
plugin: {"type":"storage.get","v":1,"requestId":"p-1","payload":{"key":"startedAt"}}
host:   {"type":"storage.get.result","v":1,"requestId":"p-1","payload":{"value":null}}
plugin: {"type":"block.setProps","v":1,"requestId":"p-2","payload":{"props":{"seconds":600}}}
host:   {"type":"block.setProps.result","v":1,"requestId":"p-2","payload":{}}
plugin: {"type":"ui.openLink","v":1,"requestId":"p-3","payload":{"url":"https://example.org/help"}}
host:   {"type":"error","v":1,"requestId":"p-3","payload":{"code":"CAPABILITY_NOT_GRANTED","message":"ui.openLink is not granted"}}
host:   {"type":"block.changed","v":1,"payload":{"width":320,"height":160}}
host:   {"type":"destroy","v":1,"payload":{}}
```
