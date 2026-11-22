// Loads the built package the way a consumer does (by its name, plain Node ESM, no bundler) and
// does one round trip. Vitest resolves imports like a bundler; this catches what only Node
// refuses (a relative import without .js, a missing file in dist/). Part of `npm run build`.
import { readdirSync } from 'node:fs';

const engine = await import('@apps/drawboard-engine');

const board = new engine.BoardDoc();
board.addBlock({ type: engine.EMOJI_TYPE, x: 0, y: 0, w: 64, h: 64, props: { emoji: '🚀' } });
const file = engine.boardToFile(board, 'Check');
const copy = new engine.BoardDoc();
engine.writeBoardFile(copy, engine.readArchive(engine.exportArchive(board, 'Check')));
if (JSON.stringify(engine.boardToFile(copy, 'Check')) !== JSON.stringify(file)) {
  throw new Error('dist: a board did not survive the archive round trip');
}
if ((await engine.loadBuiltinTemplates()).length === 0) {
  throw new Error('dist: no built-in templates');
}

const files = readdirSync('dist', { recursive: true, encoding: 'utf8' });
const missing = files
  .filter((f) => f.endsWith('.js'))
  .filter((f) => !files.includes(f.replace(/\.js$/, '.d.ts')));
if (missing.length > 0) {
  throw new Error(`dist: no declarations for ${missing.join(', ')}`);
}
console.log(`dist: ${files.filter((f) => f.endsWith('.js')).length} modules load in Node`);
