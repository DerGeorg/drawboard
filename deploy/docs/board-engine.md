# Board engine (frontend `src/board-engine/`)

The whiteboard engine of Drawboard (architecture 3.2/3.3/3.8). Plain TypeScript: **no Angular,
no RxJS** (ESLint `no-restricted-imports` for `src/board-engine/**`). Angular only creates the
engine in a host element (`board-canvas`) and renders the chrome (toolbar, style panel, top bar).
Only permissive libraries: yjs, y-protocols, lib0 (MIT), perfect-freehand (MIT).

## Layers

```
container (position: relative, the host element)
  .be-world        one CSS transform: translate(x, y) scale(zoom)
    .be-blocks     one absolutely positioned element per block (only visible ones are mounted)
    svg            connectors and freehand strokes in world coordinates (pointer-events: none)
  svg overlay      screen space: selection boxes, 8 resize handles, marquee, connector ghost line,
                   live pen stroke, remote cursors and remote selections
```

* **Re-rendering is driven by Yjs, not by frames.** `BoardDoc` emits one `BoardChange` per
  transaction (ids of changed blocks/connectors/strokes, `local` flag); the renderer updates exactly
  those elements. Connectors attached to a changed block are redrawn. Camera changes only set the
  transform; the set of mounted blocks (viewport + 300 px margin) is reconciled on the next frame.
* The overlay and culling are batched with `requestAnimationFrame` (`engine.flush()` runs it
  synchronously, used by tests).
* Strokes are not culled yet (all strokes are SVG paths); blocks are.
* Text is rendered with `createElement`/`createTextNode` only, links only for `https:`, `http:`,
  `mailto:` with `target=_blank rel="noopener noreferrer nofollow" referrerpolicy=no-referrer`
  (architecture S5.2/S5.3), at most 100 000 characters per `Y.Text`.

## Data model (`model/`)

`BoardDoc` wraps a `Y.Doc` with the schema of architecture 3.3:

```
meta        Y.Map        schemaVersion (1)
blocks      Y.Map<id, Y.Map>   id, type, x, y, w, h, rotation, z, parent, locked,
                               props: Y.Map, text?: Y.Text
connectors  Y.Map<id, Y.Map>   from, to ({block, anchor: auto|top|right|bottom|left} or {x, y}),
                               style {color, width, arrow, dashed}, label
strokes     Y.Map<id, Y.Map>   points (flat [x, y, pressure, ...], world coordinates), style {color, size}
```

* Ids are `crypto.randomUUID()`. A new block gets `z = max + 1`.
* Every mutation is one `doc.transact(fn, LOCAL_ORIGIN)`; the undo manager tracks only that origin,
  so remote edits and the provider's updates are never undone locally.
* Reads return plain objects (`getBlock`, `blocks()`, ...), cached per block and invalidated by
  the change notification. `observe(listener)` is the change stream.
* For a document that syncs with the server create `new BoardDoc(doc, false)` and call
  `initialize()` after the first sync (writes `schemaVersion` only if the server has none).
* Rotation is stored and rendered but there is no UI for it yet (hit-testing ignores it).

## Block type registry = future plugin API (`renderer/block-registry.ts`)

```ts
interface BlockType {
  type: string;                       // namespaced: core.sticky, acme.timer
  label: string;
  defaultSize: { w: number; h: number };
  defaultProps: Record<string, unknown>;   // also tells the style panel which style fields apply
  textEditable?: boolean;             // double-click / Enter opens the text editor on block.text
  render(host: HTMLElement, ctx: { block, text(): string, readOnly }): { update(block), destroy() };
}
```

Built-ins (`blocks/`): `core.sticky`, `core.text`, `core.shape` (`kind`: rect, ellipse, diamond).
They are registered by `registerBuiltinBlocks(registry)` through `registry.register`, exactly the
path a plugin block will take (M3: trusted blocks as Web Components, everything else in a sandboxed
iframe). `render` fills the block element and must only write inside `host`; exceptions from a
block type are caught and replaced by a placeholder, and unknown types render as a placeholder
while their data is kept. A block type reads its text with `ctx.text()` and marks text nodes with
the class `be-text` (the editor hides them while editing).

Style panel contract: a prop is styleable if its key (`color`, `fill`, `stroke`, `strokeWidth`) is
in `defaultProps`.

## Input and tools

`input/input-controller.ts` is the only code that sees DOM events. It converts them to normalized
events and hands them to the engine:

```ts
PointerInfo { screen, world, buttons, shift, alt, mod, pointerId, pressure, detail, touch }
KeyInfo     { key, shift, alt, mod, repeat }
WheelInfo   { screen, deltaX, deltaY, zoom }          // zoom = mod key or trackpad pinch
```

Keys from text fields are ignored, links inside blocks are left to the browser, two-finger touch
becomes pinch (zoom + pan) and cancels the running tool gesture.

A tool implements `Tool` (`tools/tool.ts`): `pointerDown/Move/Up/Cancel`, `doubleClick`, `keyDown`
(returns true if handled), `activate/deactivate`, `cursor`. It gets a `ToolContext` (the engine):
board, selection, registry, camera, `hitTest`, `blockAt`, `handleAt`, `setTool`, `startTextEdit`,
`setHints` (overlay), `stopCapturing` (new undo step), `px(n)`, `drawStyle`, `readOnly`. Tools never
touch the DOM, so every tool is unit-tested by feeding `PointerInfo`/`KeyInfo` into the engine
(`testing/helpers.ts`).

| Tool | Key | Notes |
|---|---|---|
| select | V | click, shift-toggle, marquee (shift adds), drag-move, 8 resize handles (single block, shift keeps aspect), Delete/Backspace, Escape, mod+A, mod+D (duplicate, offset 24), arrows nudge 1 / shift 10, double-click or Enter edits text |
| hand | H | also space+drag and middle button; wheel pans; mod+wheel and pinch zoom (0.02 - 8); mod+plus / mod+minus zoom, shift+1 fit, shift+0 or mod+0 100 % |
| sticky / text | S / T | click = default size centered, drag = dragged size; opens the editor, an empty new block is removed again |
| rect / ellipse / diamond | R / O / D | the same create tool with `core.shape` and `kind`; fill and stroke from `drawStyle` |
| connector | C | drag block to block, each end snaps to the nearest side of the block under the pointer, free end allowed; stores block ids, so it follows moved blocks; same block twice is ignored |
| pen | P | raw points `[x, y, pressure]`; preview in the overlay, one `addStroke` on release; outline by perfect-freehand |
| eraser | E | deletes strokes under the pointer, one drag = one undo step |

Read-only engines (`readOnly`): only select and hand, no mutating key, no text editing, no undo.

Text editing (`text/text-editor.ts`): a `textarea` inside the block element. Typing becomes one
delete and one insert on the `Y.Text` (common prefix/suffix diff); a remote edit sets the new value
and moves the caret with the Y.Text delta (`transformIndex`), so the caret does not jump.

Undo: `Y.UndoManager` over blocks/connectors/strokes, `trackedOrigins = {LOCAL_ORIGIN}`,
`captureTimeout` 500 ms; gestures call `stopCapturing()` so a drag is one step. mod+Z, mod+Shift+Z,
mod+Y.

## Engine API (`BoardEngine`)

```ts
new BoardEngine(container, board, { readOnly?, registry? })
setTool(id) / tool, toolChanged            setReadOnly(b) / readOnly
zoomIn() zoomOut() resetZoom() fit()       camera, cameraChanged; glideTo(centre, zoom) (follow); navigated (own pan/zoom)
selection (SelectionState, .changed)       setStyleForSelection(patch) / selectionStyle() / selectionStyleChanged
undo() redo() historyState historyChanged  drawStyle / setDrawStyle(patch) / drawStyleChanged
localPresence (cursor + selection out)     setPeers(peers) (remote participants in)
startTextEdit(id) flush() destroy()
selectionAnchor / selectionAnchorChanged   selection bounds in screen px (null while dragging/editing/read-only)
selectionKind() deleteSelection() duplicateSelection()
drawStyle { color, size, fill, sticky }
```

The container's background is a tiled dot grid (`grid.ts`, colour from the CSS variable `--be-grid-dot`);
sticky notes shrink their font (32 -> 10 px) until the text fits (`util/fit-text.ts`); block views may
implement `mounted()` to measure once their element is in the document.

Callbacks are `Emitter`s (`on(fn)` returns the unsubscribe function). Angular components subscribe
inside `effect` and unsubscribe in `onCleanup`.

## Collaboration (`collab/`)

Implements `api/docs/collab-protocol.md` (`drawboard.v1`) without Angular:

* `frames.ts` frame codec with lib0 (`encodeUpdate/Awareness/Ping`, `decodeServerFrame`,
  `decodeAwarenessEntry`); malformed frames throw `ProtocolError`.
* `backoff.ts` 1 s doubling to 30 s, +-20 % jitter.
* `provider.ts` `new DrawboardProvider(doc, awareness, { getTicket, uploadSnapshot, ... })`, then
  `connect()`; `destroy()` when leaving. `getTicket(): Promise<{ticket, url, protocol}>` and
  `uploadSnapshot(upToSeq, bytes)` are injected - the Angular wiring to the generated
  `CollabService` follows with contract 1.1.0. Optional: `socketOrigin`, `createSocket`
  (tests), `random`, `onError`.
  * pending queue; ACK removes the oldest entry; after SYNCED the queue is merged
    (`Y.mergeUpdates`) and sent once; applying server data uses the provider as origin (never
    echoed); viewers/commenters never send; `ROLE` frames switch at runtime;
  * close codes: 1000 stop, 1001/1011/4408/other backoff, 1009 drop queue + `reloadRequired`,
    4400 reconnect once then error, 4401 new ticket at once, 4403/4404 `denied`, 4413 `full`,
    4429 after 30 s; a failed handshake (1006 before WELCOME) asks for a new ticket once, then
    reports "Connection failed" and backs off; backoff resets after 10 s connected;
  * PING every 30 s, reconnect when nothing arrived for 60 s;
  * awareness: local state `{cursor, selection, viewport, following, summon}` only, throttled
    to 10/s, re-sent on PEER_JOINED and every 15 s; `collab/awareness-state.ts` `parsePeerState`
    validates every remote field on its own (a bad field is absent); remote states removed on PEER_LEFT and when a session ends; **names and colors
    only from the server's `From`**; entries that do not match `From.clientId` or claim our own
    client id are dropped;
  * COMPACT is answered only with an empty queue and everything up to `upToSeq` applied (the
    applied sequence is the maximum over UPDATE, ACK, SNAPSHOT and SYNCED frames, which relies on
    the server sending frames to a session in sequence order);
  * `ws://` is refused except for localhost; the ticket url must be a path.
  * status: `connecting | synced | offline | readonly | full | denied` (+ `error`, `closeCode`,
    `reloadRequired`) via `statusChanged`.
* `presence-binding.ts` `bindPresence(engine, provider)`: engine cursor/selection -> awareness,
  provider peers -> `engine.setPeers`, server role `readonly` -> `engine.setReadOnly(true)` (never
  lifts a read-only the host set).
* `testing/fake-collab-server.ts` the in-process server used by the specs.

Far out (M5 zoom-out): below 15 % zoom every block renders as a plain box (colour only from
trusted types through `safeColor`, plugin and file blocks neutral grey, titles via `textContent`),
back to full rendering above 18 %; the dot grid fades out between 15 % and 6 %; plugin iframes are
unmounted far out and remounted through the normal mount path.

Following (`collab/follow.ts` `FollowController`, no Angular): follow a participant (the camera
glides to their `viewport`, any own pan, zoom or Esc stops it) and "bring everyone to me"
(`summon {id, targets: 'all' | client ids}`). A summon is honoured only from a sender whose
server `From` says no guest and role OWNER or EDITOR (`maySummon`), once per sender and summon
id, at most once per sender per 15 s; stopping two summons of the same sender within 2 min
ignores them for the session (undo in the participant menu). Security decisions: architecture.md
section 8, "Zoom-out, follow and summon".

## Files, diagrams, plugins (M3)

* `blocks/file.ts` `core.file` (props: `fileId` only) renders through an injected `FileSource`
  (`files/file-source.ts`: `watch`, `download`, `refresh`); the Angular `BoardFiles` fetches
  metadata and signed URLs and renews them. `files/pdf-view.ts` is the pdf.js renderer (lazy
  chunk, bytes passed as data, assets from `/pdfjs/`). `registerBuiltinBlocks(registry,
  { files, fileRenderers, diagrams })`; missing services degrade to "not available" / source text.
* `blocks/mermaid.ts` `core.mermaid`: source in the block's `Y.Text`, rendered by an injected
  `DiagramRenderer` (`diagrams/mermaid-renderer.ts`: strict Mermaid + DOMPurify, S5.1). Block
  types with `opensEditor` make a double-click emit `engine.blockOpened`; `engine.setBlockText`
  writes an outside editor's text as the smallest Y.Text edit.
* `plugins/`: `PluginHost` validates enabled plugins, registers their block types with
  `registry.registerAll` (the renderer re-renders blocks of changed types; `unregisterAll` turns
  them back into placeholders), keeps at most 50 frames for on-screen blocks, and executes the
  capability requests; `PluginInstance` is one sandboxed frame with its MessageChannel and the
  checks of S3.7; `protocol.ts` holds limits and schemas. `engine.readOnlyChanged` drives
  `mode.changed`; `BoardDoc.replaceProps` is `block.setProps`.
* `engine.insertBlock({type, at, size?, props?, text?})` (one undo step, selected),
  `worldAtClient`, `visibleCenter`; elements with `data-be-interactive` inside a block take their
  own pointer input (download buttons, video controls, the PDF pager).
* The plugin SDK (`src/plugin-sdk/`) is not part of the engine and must not import it.

## Tests

`ng test` (Vitest + jsdom). jsdom has no layout, so geometry comes from the camera and block data;
the viewport is "unmeasured" (everything is mounted) until `setViewportSize` is called. Not
covered by unit tests: real pointer capture, real layout/culling in a browser, touch gestures on a
device, IME input in the text editor, and the visual result.
