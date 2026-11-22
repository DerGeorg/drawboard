# Drawboard engine core

The DOM-free core of the Drawboard board engine as the npm package `@apps/drawboard-engine`:
board model, file format and its validation, templates, collaboration protocol and provider. The
frontend, the MCP server and the desktop app use it, so a board is read, checked and synced the
same way everywhere.

Plain TypeScript, ESM, no Angular, no RxJS, no DOM. It runs in a browser and in Node 22+. The
concept of the engine is in `docs/board-engine.md` of the Drawboard project; the code was taken
out of the frontend (`src/board-engine/`, entry `core.ts`) unchanged except for import paths.

Licence: AGPL-3.0-only ([`LICENSE`](LICENSE)), like the other Drawboard repositories.

## What is in it

One entry point, `@apps/drawboard-engine` (`src/core.ts`). Everything the package offers is
exported from there; the other modules are internal and have no subpath export.

| Area          | Modules                                                                    | What                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Board model   | `model/types`, `model/board-doc`, `model/block-types`                      | `BoardDoc` over a `Y.Doc` (blocks, connectors, strokes), the typed reads, the built-in block types, default sizes and the sticky palette |
|               | `model/frames`, `model/tables`                                             | frames (parent links without cycles, bounded depth) and tables (frames of cells)                                                         |
|               | `model/story-model`, `model/kanban-model`                                  | story cards and the kanban block (columns, cards, limits)                                                                                |
|               | `text/text-diff`                                                           | the text arithmetic of collaborative editing (`textDiff`, `transformIndex`, `applyTextDiff`)                                             |
| Values        | `util/emoji`, `gifs/gif`, `plugins/protocol` (limits and JSON checks only) | validation of single values the file format shares with the views (emoji, GIPHY ids and URLs, plugin state)                              |
| File format   | `io/board-file`                                                            | `board.json`: `boardToFile`, `parseBoardFile` (the import rules and limits), `writeBoardFile`, `ImportError`                             |
|               | `io/archive`, `io/data-url`                                                | the `.drawboard` archive (zip) and board links (`v1.<base64url(deflate)>`)                                                               |
|               | `io/clipboard`, `io/board-copy`                                            | copy and paste envelopes (untrusted input) and importable copies of live boards                                                          |
| Templates     | `templates/*`                                                              | `TemplateBuilder`, the built-in templates (`loadBuiltinTemplates`, loaded lazily) and the preview of a template                          |
| Collaboration | `collab/frames`, `collab/awareness-state`, `collab/backoff`                | the wire format of `drawboard.v1`, the awareness state and its validation, the reconnect backoff                                         |
|               | `collab/provider`, `presence`                                              | `DrawboardProvider`: keeps a `Y.Doc` and its `Awareness` in sync with the backend; the WebSocket is injectable                           |
| Colours       | `palette`, `theme`                                                         | the palettes of the style panel and the display mapping of the themes                                                                    |
| Internal      | `camera`, `files/file-source`, `util/emitter`, `util/geometry`             | used by the modules above, not exported                                                                                                  |

## What is deliberately not in it

Everything that needs a DOM or belongs to the editor stays in the frontend: the renderers and
block views (`blocks/`, `renderer/`), tools and input, the text editor, selection, grid, scene,
`BoardEngine` itself, undo (`undo.ts`), the PDF view, Mermaid diagrams, the plugin host and plugin
instances, GIF consent and slots, follow mode and the presence binding.

A new module in the package is a deliberate decision: it becomes package API. `src/core.spec.ts`
fixes the list.

## How it is kept DOM-free

- `src/core.spec.ts` (the package test "no DOM, only these dependencies") walks every import from
  `core.ts`: no module may use a DOM global or a view module, it must reach exactly the listed
  modules, every module under `src/` must be reachable (nothing ships by accident), only `yjs`,
  `y-protocols/awareness`, `lib0/encoding|decoding` and `fflate` may be imported, and
  `package.json` must declare exactly these packages. It also runs round trips (board.json,
  archive, board link, templates, two providers over an injected socket) without a DOM.
- ESLint refuses DOM globals, DOM types, Angular, RxJS and imports from the view side or from
  `src/testing/` in the package sources (the same block as in the frontend).
- `tsconfig.json` has no `dom` lib. The one host global the core reads, `location`, is declared in
  `src/host.d.ts`.
- All specs run in Node. Only `collab/provider.spec.ts` gets a page `location` (vitest project
  `page`, `src/testing/page-location.ts`), because it checks the default WebSocket origin.
- `npm run build` ends with `scripts/check-dist.mjs`: it imports the built package by its name in
  plain Node ESM (no bundler), does a round trip and checks that every module has declarations.

## Dependencies

| Package       | As             | Why                                                                                                                                                                                                                    |
| ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yjs`         | peerDependency | The host creates the `Y.Doc` and hands it to `BoardDoc` and the provider. Yjs must exist once per application: two copies break `instanceof` checks and Yjs warns about it. As a peer the host's copy is the only one. |
| `y-protocols` | peerDependency | The host creates the `Awareness` for the provider (`new Awareness(doc)`), so it imports `y-protocols` itself; the provider must work on that same instance and its Yjs.                                                |
| `lib0`        | dependency     | Only the stateless `encoding`/`decoding` functions of the wire format; nothing is shared with the host.                                                                                                                |
| `fflate`      | dependency     | Zip and deflate for the archive and board links; internal.                                                                                                                                                             |

All four are MIT. The rule of the project holds for every addition: open source with a permissive
licence (MIT, Apache-2.0, BSD, ISC), no licence keys or fees. `emojibase-data` (MIT) is a dev
dependency for one spec only.

## Installing

The package is served through the instance-level endpoint of the GitLab package registry (the
scope `@apps` is the root group of `apps/drawboard/engine`). `.npmrc` of the consumer:

```
@apps:registry=https://gitlab.dergeorg.at/api/v4/packages/npm/
//gitlab.dergeorg.at/api/v4/packages/npm/:_authToken=${NPM_TOKEN}
```

- locally: `NPM_TOKEN` = personal access token with scope `read_api`;
- in CI: `NPM_TOKEN=$CI_JOB_TOKEN`. The consumer's project must be on the job-token allowlist of
  this project; the group `apps/drawboard` is.

```
npm install @apps/drawboard-engine yjs y-protocols
```

## Using it

```ts
import * as Y from 'yjs';
import { BoardDoc, boardToFile, parseBoardFile, writeBoardFile } from '@apps/drawboard-engine';

const board = new BoardDoc();
writeBoardFile(board, parseBoardFile(JSON.parse(text))); // throws ImportError on bad input
const file = boardToFile(board, 'My board');
```

### The collab provider under Node

`DrawboardProvider` is the same class the frontend uses. In a page it derives the WebSocket
origin from `location` and opens a browser `WebSocket`. Under Node the host gives it what a page
would:

```ts
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { BoardDoc, DrawboardProvider } from '@apps/drawboard-engine';

const doc = new Y.Doc();
const board = new BoardDoc(doc, false); // false: no schema write before the first sync
const provider = new DrawboardProvider(doc, new Awareness(doc), {
  // POST /api/boards/{id}/collab-ticket - called before every (re)connect, tickets are single use
  // (`api` stands for the host's client of the Drawboard API)
  getTicket: () => api.collabTicket(boardId), // { ticket, url: '/api/boards/…/collab', protocol }
  // PUT /api/boards/{id}/snapshot?upToSeq=… - compaction when the server asks for it
  uploadSnapshot: (upToSeq, bytes) => api.uploadSnapshot(boardId, upToSeq, bytes),
  // required under Node (there is no location): wss://host, ws:// only for localhost
  socketOrigin: 'wss://draw.example.com',
  // optional: Node 22+ has a global WebSocket; inject another one (e.g. with an agent or headers)
  createSocket: (url, protocols) => new WebSocket(url, protocols),
  onError: (e) => log.warn(e),
});
provider.statusChanged.on((s) => {
  if (s.status === 'synced') {
    board.initialize(); // once after the first sync: a no-op when the document has a schema
  }
});
provider.connect();
// …
provider.destroy();
```

- The ticket goes to the server as subprotocol `ticket.<ticket>` next to `drawboard.v1`; the
  ticket URL must be a path, it is appended to `socketOrigin`.
- Without `socketOrigin` under Node every connect fails (reported through `onError`) and is
  retried with backoff.
- `documentReplaced` fires when an owner restored an older version (close code 4410): discard the
  `Y.Doc`, create a new one with a new provider and join again.
- Close codes, limits and the protocol: `api/docs/collab-protocol.md` in the contract repository
  and the comments in `src/collab/provider.ts`.

## Development

Node 22 or newer; `npm install` needs `NPM_TOKEN` for `@ci/eslint-plugin` (see `.npmrc`).

| Command                | What                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`             | Vitest in Node                                                                                                                               |
| `npm run test:ci`      | `tsc` over sources and specs, then Vitest with coverage (thresholds as in the frontend: 80 / 70 / 80 / 80) and a JUnit report under `junit/` |
| `npm run lint`         | ESLint (`@ci/eslint-plugin` configs.tests plus the DOM rules)                                                                                |
| `npm run format:check` | Prettier                                                                                                                                     |
| `npm run build`        | `tsc` to `dist/` (`.js`, `.d.ts`, source maps), then `scripts/check-dist.mjs`                                                                |

Source imports carry the `.js` extension (`./model/board-doc.js`): Node ESM resolves them
literally, and tsc builds `.js` from the `.ts` beside them.

## Versioning and releases

The version comes from the commit messages (Conventional Commits, semantic-release) in the
pipeline: `fix:` a patch, `feat:` a minor, `feat!:` / `BREAKING CHANGE:` a major. A change of the
exported API that breaks a consumer is a major. `package.json` keeps the placeholder `0.0.0`; the
job `npm:publish` writes the real version into the package. Every pipeline packs the package (the
`.tgz` is an artifact of `npm:publish`, installable for a trial); a push to `main` with a due
release publishes it to this project's registry and then creates the tag and the GitLab release.
