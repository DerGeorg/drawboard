/**
 * The DOM-free core of the board engine: the board model, the file format, the templates and
 * the collaboration protocol. It runs in a browser, in Node (MCP server) and in a desktop app
 * alike and becomes the package `@apps/drawboard-engine` (docs/board-engine.md).
 *
 * Nothing reachable from here may use the DOM (`document`, `window`, elements, canvas,
 * observers) or Angular: `core.spec.ts` runs this entry in a Node environment and checks its
 * import graph, the lint rule for the core files (eslint.config.mjs) refuses imports from the
 * view side. Renderers, tools, input, the text editor and the plugin host stay outside.
 */

// The board model
export * from './model/types.js';
export * from './model/board-doc.js';
export * from './model/frames.js';
export * from './model/tables.js';
export * from './model/block-types.js';
export * from './model/story-model.js';
export * from './model/kanban-model.js';
export * from './text/text-diff.js';

// Validation of single values the file format shares with the views
export * from './util/emoji.js';
export * from './gifs/gif.js';
export {
  CAPABILITIES,
  EVENTS,
  LIMITS as PLUGIN_LIMITS,
  PAYLOADS,
  PLUGIN_API_VERSION,
  PLUGIN_ID,
  PluginError,
  REQUESTS,
  TokenBucket,
  isPlainJson,
  jsonBytes,
  parseEnvelope,
  withinBound,
} from './plugins/protocol.js';
export type {
  Capability,
  CapabilityName,
  Envelope,
  ErrorCode as PluginErrorCode,
} from './plugins/protocol.js';

// The file format: board.json, the .drawboard archive, board links, the clipboard, copies
export * from './io/board-file.js';
export * from './io/archive.js';
export * from './io/data-url.js';
export * from './io/board-copy.js';
export {
  CLIPBOARD_LIMITS,
  CLIPBOARD_MIME,
  CLIPBOARD_VERSION,
  PASTE_OFFSET,
  WEB_CLIPBOARD_MIME,
  copySet,
  copyToClipboard,
  parseClipboard,
  pasteClipboard,
  utf8Bytes,
} from './io/clipboard.js';
export type {
  ClipboardContent,
  ClipboardEnvelope,
  CopyResult as ClipboardCopyResult,
  CopySet,
  PasteResult,
} from './io/clipboard.js';

// Templates
export * from './templates/template-builder.js';
export * from './templates/load-builtin-templates.js';
export type { BuiltinTemplate } from './templates/builtin-templates.js';
export * from './templates/template-preview.js';

// Collaboration: wire protocol, awareness, the provider (the WebSocket is injectable)
export * from './collab/frames.js';
export * from './collab/awareness-state.js';
export * from './collab/backoff.js';
export * from './collab/provider.js';
export type { LocalPresence, PeerPresence } from './presence.js';
export { safeColor } from './presence.js';

// Colours: palettes and the display mapping of the themes
export * from './palette.js';
export * from './theme.js';

// Geometry, the camera and small helpers the views share with the model
export * from './util/geometry.js';
export * from './camera.js';
export * from './util/emitter.js';
export * from './files/file-source.js';
