// @vitest-environment node
/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  BoardDoc,
  DrawboardProvider,
  EMOJI_TYPE,
  GIF_TYPE,
  STICKY_COLORS,
  TemplateBuilder,
  boardToFile,
  decodeDataUrlFragment,
  encodeDataUrlFragment,
  exportArchive,
  loadBuiltinTemplates,
  parseBoardFile,
  readArchive,
  writeBoardFile,
} from './core.js';
import { FakeCollabServer } from './testing/fake-collab-server.js';

/** The package sources, seen from the repository root (vitest runs there). */
const SRC = join(process.cwd(), 'src');

/** Packages the core may import: all MIT, none of them touches the DOM. */
const PACKAGES = [/^yjs$/, /^y-protocols\/awareness$/, /^lib0\/(encoding|decoding)$/, /^fflate$/];

/** The npm packages behind them: exactly what package.json declares for consumers. */
const DECLARED = ['fflate', 'lib0', 'y-protocols', 'yjs'];

/** What the core must not use, in code (comments are stripped first). */
const DOM =
  /\b(document|window|navigator|localStorage|sessionStorage|HTMLElement|HTML\w*Element|SVG\w*Element|ownerDocument|createElement|Canvas\w*|OffscreenCanvas|IntersectionObserver|ResizeObserver|MutationObserver|requestAnimationFrame|getComputedStyle|DOMParser)\b/;

/**
 * The view side of the board engine (renderers, tools, input, text editor, plugin host): it
 * stays in the frontend and must never be copied into this package.
 */
const VIEW =
  /^(blocks|renderer|input|tools|diagrams)\/|^(engine|scene|selection|grid|undo|index)\.ts$|^text\/text-editor\.ts$|^files\/pdf-view\.ts$|^plugins\/plugin-(host|instance)\.ts$|^gifs\/gif-(consent|slots)\.ts$|^collab\/(follow|presence-binding)\.ts$|^util\/(fit-text|safe-text)\.ts$/;

/** The modules of the package: a new one is a deliberate decision (it becomes package API). */
const CORE_MODULES = [
  'camera.ts',
  'collab/awareness-state.ts',
  'collab/backoff.ts',
  'collab/frames.ts',
  'collab/provider.ts',
  'core.ts',
  'files/file-source.ts',
  'gifs/gif.ts',
  'io/archive.ts',
  'io/board-copy.ts',
  'io/board-file.ts',
  'io/clipboard.ts',
  'io/data-url.ts',
  'model/block-types.ts',
  'model/board-doc.ts',
  'model/frames.ts',
  'model/kanban-model.ts',
  'model/story-model.ts',
  'model/tables.ts',
  'model/types.ts',
  'palette.ts',
  'plugins/protocol.ts',
  'presence.ts',
  'templates/builtin-templates.ts',
  'templates/load-builtin-templates.ts',
  'templates/template-builder.ts',
  'templates/template-preview.ts',
  'text/text-diff.ts',
  'theme.ts',
  'util/emitter.ts',
  'util/emoji.ts',
  'util/geometry.ts',
];

/** Code without comments (good enough for the package's own sources). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

function specifiers(source: string): string[] {
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'/gm, // import … from / export … from
    /^\s*import\s*'([^']+)'/gm, // import for side effects
    /\bimport\(\s*'([^']+)'\s*\)/g, // lazy import
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1] as string));
}

interface Graph {
  modules: string[];
  packages: string[];
  problems: string[];
}

/** Follows every import from `core.ts`, relative ones into src/, others as packages. */
function walk(): Graph {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const problems: string[] = [];
  const queue = ['core.ts'];
  while (queue.length > 0) {
    const module = queue.shift() as string;
    if (seen.has(module)) {
      continue;
    }
    seen.add(module);
    if (VIEW.test(module)) {
      problems.push(`${module} is on the view side`);
    }
    const source = code(readFileSync(join(SRC, module), 'utf8'));
    const dom = DOM.exec(source);
    if (dom) {
      problems.push(`${module} uses ${dom[1]}`);
    }
    for (const spec of specifiers(source)) {
      if (spec.startsWith('.')) {
        // Node resolves ESM imports literally: `./x.js`, which tsc builds from `./x.ts`.
        if (!spec.endsWith('.js')) {
          problems.push(`${module} imports ${spec} without the .js extension`);
          continue;
        }
        const target = relative(SRC, join(SRC, dirname(module), spec)).replace(/\.js$/, '.ts');
        if (target.startsWith('..')) {
          problems.push(`${module} imports ${spec} from outside src/`);
        } else {
          queue.push(target);
        }
      } else if (PACKAGES.some((p) => p.test(spec))) {
        packages.add(spec);
      } else {
        problems.push(`${module} imports the package ${spec}`);
      }
    }
  }
  return { modules: [...seen].sort(), packages: [...packages].sort(), problems };
}

/** Every module that tsc builds into dist/: no specs, no test helpers, no declarations. */
function shippedModules(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((path) => path.split('\\').join('/'))
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts'))
    .filter((path) => !path.startsWith('testing/'))
    .sort();
}

/** The package root of an import (`lib0/encoding` -> `lib0`, `@scope/x/y` -> `@scope/x`). */
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

describe('core', () => {
  describe('the package: no DOM, only these dependencies', () => {
    it('when every import from core.ts is followed then no module uses the DOM, Angular or a view', () => {
      expect(walk().problems, 'problems').toEqual([]);
    });

    it('when every import from core.ts is followed then it reaches exactly the core modules', () => {
      expect(walk().modules, 'modules').toEqual(CORE_MODULES);
    });

    it('when the sources are listed then every module that ships is reachable from core.ts', () => {
      expect(shippedModules(), 'modules in src/').toEqual(CORE_MODULES);
    });

    it('when every import from core.ts is followed then only the allowed packages are used', () => {
      expect(walk().packages, 'packages').toEqual([
        'fflate',
        'lib0/decoding',
        'lib0/encoding',
        'y-protocols/awareness',
        'yjs',
      ]);
    });

    it('when package.json is read then it declares exactly the packages the core imports', () => {
      const manifest = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
      ) as Manifest;
      const declared = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
      const imported = [...new Set(walk().packages.map(packageName))];

      expect(declared.sort(), 'dependencies + peerDependencies').toEqual(DECLARED);
      expect(imported.sort(), 'imported packages').toEqual(DECLARED);
    });
  });

  describe('in Node without a DOM', () => {
    function richBoard(): BoardDoc {
      const builder = new TemplateBuilder('Planning');
      const frame = builder.frame('Sprint', 0, 0, 1200, 800, '#f1f5f9');
      builder.sticky('Idea', 40, 80, 160, 160, STICKY_COLORS[0], { in: frame });
      builder.kanban('Board', ['To do', 'Doing', 'Done'], 240, 80, 900, 500);
      builder.story('Login', 'As a user I want to sign in', ['works with OIDC'], 40, 600);
      const board = new BoardDoc();
      writeBoardFile(board, parseBoardFile(builder.build()));
      board.addBlock({ type: EMOJI_TYPE, x: 10, y: 900, w: 64, h: 64, props: { emoji: '🚀' } });
      board.addBlock({
        type: GIF_TYPE,
        x: 100,
        y: 900,
        w: 240,
        h: 180,
        props: { giphyId: 'abc123', alt: 'A cat' },
      });
      return board;
    }

    it('when the core is loaded then there is no DOM in this environment', () => {
      expect('document' in globalThis, 'document').toBe(false);
      expect('window' in globalThis, 'window').toBe(false);
    });

    it('when a board is exported, parsed and written into an empty one then the file is the same', () => {
      const source = richBoard();
      const exported = boardToFile(source, 'Planning');
      const parsed = parseBoardFile(JSON.parse(JSON.stringify(exported)));
      const target = new BoardDoc();
      writeBoardFile(target, parsed);

      expect(boardToFile(target, 'Planning'), 'file').toEqual(exported);
      expect(target.blocks().length, 'blocks').toBe(6);
    });

    it('when a board goes through an archive and a board link then it comes back the same', () => {
      const source = richBoard();
      const exported = boardToFile(source, 'Planning');

      const fromArchive = new BoardDoc();
      writeBoardFile(fromArchive, readArchive(exportArchive(source, 'Planning')));
      const fromLink = new BoardDoc();
      writeBoardFile(fromLink, decodeDataUrlFragment(encodeDataUrlFragment(source, 'Planning')));

      expect(boardToFile(fromArchive, 'Planning'), 'archive').toEqual(exported);
      expect(boardToFile(fromLink, 'Planning'), 'link').toEqual(exported);
    });

    it('when the built-in templates are loaded then every one passes the import rules', async () => {
      const templates = await loadBuiltinTemplates();

      expect(templates.length, 'templates').toBeGreaterThan(0);
      for (const t of templates) {
        expect(() => parseBoardFile(structuredClone(t.file)), t.id).not.toThrow();
      }
    });

    describe('the collab provider', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('when two providers share a board given an injected socket then an edit reaches the other', async () => {
        const server = new FakeCollabServer();
        const join = (): { board: BoardDoc; provider: DrawboardProvider } => {
          const board = new BoardDoc(new Y.Doc(), false);
          const provider = new DrawboardProvider(board.doc, new Awareness(board.doc), {
            getTicket: () =>
              Promise.resolve({
                ticket: 't',
                url: '/api/boards/b1/collab',
                protocol: 'drawboard.v1',
              }),
            uploadSnapshot: () => Promise.resolve(),
            socketOrigin: 'wss://board.example.com',
            createSocket: server.createSocket,
            random: () => 0.5,
          });
          provider.connect();
          return { board, provider };
        };
        const a = join();
        const b = join();
        await vi.advanceTimersByTimeAsync(0);

        a.board.addBlock({ type: EMOJI_TYPE, x: 0, y: 0, w: 64, h: 64, props: { emoji: '👍' } });
        await vi.advanceTimersByTimeAsync(0);

        expect(a.provider.state.status, 'status').toBe('synced');
        expect(
          b.board.blocks().map((x) => x.props['emoji']),
          'emoji',
        ).toEqual(['👍']);
        a.provider.destroy();
        b.provider.destroy();
      });
    });
  });
});
