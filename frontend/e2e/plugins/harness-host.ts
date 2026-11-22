import '../../src/trusted-types'; // first, as in main.ts
// The board side of the sandbox tests: the real engine and PluginHost with the real connector
// (postMessage of the port into the frame), bundled by esbuild in sandbox.spec.ts. No Angular,
// no backend: the spec serves this page, the frame document and the hostile plugin itself.
import { BoardEngine } from '../../src/board-engine/engine';
import { BoardDoc } from '@apps/drawboard-engine';
import { PluginHost } from '../../src/board-engine/plugins/plugin-host';

declare global {
  interface Window {
    harness: {
      props(id: string): unknown;
      blockIds: { own: string; other: string };
      beats?(): number;
    };
  }
}

const config = JSON.parse(document.getElementById('config')?.textContent ?? '{}') as {
  pluginId: string;
  assetBase: string;
  /** The plugin module in the asset base (default: the hostile one). */
  entry?: string;
};

const board = new BoardDoc();
const container = document.getElementById('board') as HTMLElement;
const engine = new BoardEngine(container, board);
const host = new PluginHost(
  engine,
  {
    boardId: 'board-1',
    boardTitle: () => 'Sandbox',
    role: () => 'EDITOR',
    userName: () => 'Alice',
    guest: () => false,
    locale: 'en',
    colorScheme: () => 'light',
  },
  {
    getStorage: () => Promise.resolve({ data: {}, version: 0 }),
    putStorage: () => Promise.resolve(),
    toast: () => undefined,
    confirmLink: () => Promise.resolve(false),
    openLink: () => undefined,
  },
);
host.setPlugins([
  {
    id: config.pluginId,
    version: '1.0.0',
    assetBase: config.assetBase,
    entry: config.entry ?? 'evil.js',
    integrity: 'sha384-ignored-by-the-host',
    blockTypes: [
      { type: `${config.pluginId}.block`, label: 'Evil', defaultWidth: 300, defaultHeight: 200 },
    ],
    // nothing granted
    grantedCapabilities: [],
    userPseudonym: 'x'.repeat(43),
  },
]);
const own = board.addBlock({
  type: `${config.pluginId}.block`,
  x: 10,
  y: 10,
  w: 300,
  h: 200,
  props: { mine: true },
});
const other = board.addBlock({
  type: 'core.sticky',
  x: 400,
  y: 10,
  w: 200,
  h: 200,
  props: { color: '#fde68a' },
  text: 'not yours',
});
window.harness = { props: (id) => board.getBlock(id)?.props, blockIds: { own, other } };
// the board must stay responsive whatever a plugin sends: a heartbeat the spec can read
let beats = 0;
setInterval(() => (beats += 1), 50);
Object.assign(window.harness, { beats: () => beats });
