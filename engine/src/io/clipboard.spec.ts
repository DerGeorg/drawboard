import { STORY_TYPE } from '../model/story-model.js';
import { BoardDoc } from '../model/board-doc.js';
import { ImportError } from './board-file.js';
import {
  CLIPBOARD_LIMITS,
  ClipboardEnvelope,
  copySet,
  copyToClipboard,
  parseClipboard,
  pasteClipboard,
  utf8Bytes,
} from './clipboard.js';

const SOURCE = '0192bbbb-0000-7000-8000-00000000b0a2';
const OTHER = '0192bbbb-0000-7000-8000-00000000c0c3';
const FILE_ID = '0192aaaa-0000-7000-8000-0000000000f1';

const block = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'b1',
  type: 'core.sticky',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  z: 1,
  parent: null,
  locked: false,
  props: { color: '#fde68a' },
  text: 'hello',
  ...overrides,
});

/** Clipboard text with the given content (and envelope overrides). */
function envelope(
  content: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    drawboard: 'clipboard',
    version: 1,
    sourceBoard: SOURCE,
    content: {
      schemaVersion: 1,
      title: '',
      blocks: [block()],
      connectors: [],
      strokes: [],
      ...content,
    },
    ...overrides,
  });
}

/** The user message of the refusal, or 'NOT REJECTED'. */
function refusal(json: string, pluginTypes?: ReadonlySet<string>): string {
  try {
    parseClipboard(json, { pluginTypes });
  } catch (error) {
    expect(error, 'error type').toBeInstanceOf(ImportError);
    return (error as ImportError).message;
  }
  return 'NOT REJECTED';
}

describe('clipboard', () => {
  let board: BoardDoc;
  beforeEach(() => (board = new BoardDoc()));
  afterEach(() => board.destroy());

  const sticky = (x = 0, y = 0, text = 'note'): string =>
    board.addBlock({
      type: 'core.sticky',
      x,
      y,
      w: 100,
      h: 100,
      props: { color: '#fde68a' },
      text,
    });

  describe('copySet', () => {
    it('when blocks are selected then connectors between them come along, others do not', () => {
      const a = sticky();
      const b = sticky(200);
      const c = sticky(400);
      const ab = board.addConnector({ block: a, anchor: 'auto' }, { block: b, anchor: 'auto' });
      const bc = board.addConnector({ block: b, anchor: 'auto' }, { block: c, anchor: 'auto' });
      const free = board.addConnector({ x: 0, y: 0 }, { x: 10, y: 10 });

      const set = copySet(board, [a, b]);

      expect(set.blocks, 'blocks').toEqual([a, b]);
      expect(set.connectors, 'only the connector between two copied blocks').toEqual([ab]);
      expect(set.connectors, 'not one with an end outside').not.toContain(bc);
      expect(set.connectors, 'not an unselected free one').not.toContain(free);
    });

    it('when a connector or stroke is selected then it is copied if its block ends are copied', () => {
      const a = sticky();
      const half = board.addConnector({ block: a, anchor: 'auto' }, { x: 500, y: 0 });
      const loose = board.addConnector({ block: sticky(900), anchor: 'auto' }, { x: 0, y: 0 });
      const stroke = board.addStroke([0, 0, 0.5, 10, 10, 0.5], { color: '#0f172a', size: 4 });

      const set = copySet(board, [a, half, loose, stroke]);

      expect(set.connectors, 'free end plus copied block').toEqual([half]);
      expect(set.strokes, 'strokes').toEqual([stroke]);
    });
  });

  describe('copySet with frames', () => {
    it('when a frame is copied then everything inside it at any depth comes along', () => {
      const frame = board.addBlock({ type: 'core.frame', x: 0, y: 0, w: 500, h: 500 });
      const inner = board.addBlock({
        type: 'core.frame',
        x: 10,
        y: 10,
        w: 200,
        h: 200,
        parent: frame,
      });
      const note = board.addBlock({
        type: 'core.sticky',
        x: 20,
        y: 40,
        w: 50,
        h: 50,
        parent: inner,
      });
      const outside = sticky(900, 900);

      const set = copySet(board, [frame]);
      const result = copyToClipboard(board, [inner], SOURCE);

      expect(set.blocks, 'frame, inner frame, note').toEqual([frame, inner, note]);
      expect(set.blocks, 'not outside').not.toContain(outside);
      const json = 'error' in result ? '' : result.content.json;
      expect(json, 'inner frame is top level in the copy').toContain(`"id":"${inner}"`);
      expect(json, 'its parent is not copied').not.toContain(`"parent":"${frame}"`);
      expect(json, 'the note keeps its link').toContain(`"parent":"${inner}"`);
    });
  });

  describe('copyToClipboard', () => {
    it('when blocks are copied then the envelope names the source board and the text is in reading order', () => {
      const lower = sticky(0, 300, 'second');
      const upper = sticky(0, 0, 'first');
      sticky(500, 500, '   ');

      const result = copyToClipboard(board, [lower, upper], SOURCE);

      if ('error' in result) {
        throw new Error(result.error);
      }
      const parsed = JSON.parse(result.content.json) as Record<string, unknown>;
      expect(parsed['drawboard'], 'marker').toBe('clipboard');
      expect(parsed['version'], 'version').toBe(1);
      expect(parsed['sourceBoard'], 'source').toBe(SOURCE);
      expect(result.content.text, 'text/plain').toBe('first\nsecond');
    });

    it('when a copied block has a parent that is not copied then the copy has none', () => {
      const parent = sticky();
      const child = board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10, parent });

      const result = copyToClipboard(board, [child], SOURCE);

      const json = 'error' in result ? '' : result.content.json;
      expect(json, 'no dangling parent').toContain('"parent":null');
    });

    it('when the selection is over the limits then nothing is copied and the reason is given', () => {
      const ids = board.blocks().map((b) => b.id);
      board.transact(() => {
        for (let i = 0; i <= CLIPBOARD_LIMITS.maxBlocks; i++) {
          ids.push(sticky(i, 0, ''));
        }
      });

      const tooMany = copyToClipboard(board, ids, SOURCE);
      // 60 notes of 50 000 two-byte characters: about 6 MB of JSON
      const big: string[] = [];
      board.transact(() => {
        for (let i = 0; i < 60; i++) {
          big.push(sticky(0, 0, 'é'.repeat(50_000)));
        }
      });
      const tooBig = copyToClipboard(board, big, SOURCE);

      expect('error' in tooMany && tooMany.error, 'count').toContain('too large');
      expect('error' in tooBig && tooBig.error, 'bytes').toContain('512 KB');
    });
  });

  describe('parseClipboard', () => {
    it('when the content is valid then a clean copy is returned with the source board', () => {
      const parsed = parseClipboard(envelope({ extra: 1 }));

      expect(parsed.sourceBoard, 'source').toBe(SOURCE);
      expect(parsed.content.blocks[0]?.text, 'text').toBe('hello');
      expect(parsed.skippedTypes, 'nothing skipped').toBe(0);
    });

    it('when a pasted stamp holds an emoji then it is kept, and anything else is refused', () => {
      const stamp = (emoji: string): string =>
        envelope({ blocks: [block({ type: 'core.emoji', props: { emoji }, text: undefined })] });

      expect(parseClipboard(stamp('🎉')).content.blocks[0]?.props, 'emoji').toEqual({
        emoji: '🎉',
      });
      expect(refusal(stamp('<img src=x>')), 'markup').toMatch(/emoji/);
      expect(refusal(stamp('🎉 🎉')), 'space').toMatch(/emoji/);
    });

    it('when a pasted GIF holds a GIPHY id then it is kept, and a URL or path is refused (G9)', () => {
      const gif = (giphyId: string): string =>
        envelope({ blocks: [block({ type: 'core.gif', props: { giphyId }, text: undefined })] });

      expect(parseClipboard(gif('abc123')).content.blocks[0]?.props, 'id').toEqual({
        giphyId: 'abc123',
      });
      expect(refusal(gif('https://evil.example/x.gif')), 'URL').toMatch(/GIF id/);
      expect(refusal(gif('../x')), 'path').toMatch(/GIF id/);
    });

    it('when the clipboard is larger than 512 KB then it is refused before parsing', () => {
      const big = 'x'.repeat(CLIPBOARD_LIMITS.maxBytes + 1);
      const wide = '€'.repeat(CLIPBOARD_LIMITS.maxBytes / 3 + 1);

      expect(refusal(big), 'length').toContain('more than 512 KB');
      expect(refusal(wide), 'utf-8 bytes').toContain('more than 512 KB');
      expect(utf8Bytes('a€😀'), 'byte count').toBe(1 + 3 + 4);
    });

    it('when the clipboard is not our envelope then it is refused', () => {
      expect(refusal('{not json'), 'not JSON').toContain('does not hold board content');
      expect(refusal('[1,2]'), 'not an object').toContain('does not hold board content');
      expect(refusal(envelope({}, { drawboard: 'other' })), 'marker').toContain(
        'does not hold board content',
      );
      expect(refusal(envelope({}, { version: 2 })), 'version').toContain('newer version');
      expect(refusal(envelope({}, { sourceBoard: '../x' })), 'source id').toContain(
        'no valid source board',
      );
    });

    it('when content breaks the import rules then it is refused with the import reason', () => {
      expect(refusal(envelope({ blocks: [block({ x: Infinity })] })), 'finite').toContain(
        'x of block 0 must be a finite number',
      );
      expect(
        refusal(envelope({ blocks: [block({ props: { color: 'url(https://evil)' } })] })),
        'colour (S5.2)',
      ).toContain('hex colour');
      expect(refusal(envelope({ blocks: [block({ parent: 'nope' })] })), 'parent').toContain(
        'parent that does not exist',
      );
      expect(refusal(envelope({ schemaVersion: 9 })), 'schema').toContain('Nothing was pasted');
    });

    it('when a block type is a prototype key or an unknown core type then it is left out, never resolved', () => {
      const parsed = parseClipboard(
        envelope({
          blocks: [
            block({ id: 'a', type: 'constructor' }),
            block({ id: 'b', type: '__proto__' }),
            block({ id: 'c', type: 'core.gone' }),
            block({ id: 'd' }),
          ],
        }),
      );

      expect(
        parsed.content.blocks.map((b) => b.id),
        'only the known type',
      ).toEqual(['d']);
      expect(parsed.skippedTypes, 'three left out').toBe(3);
    });

    it('when blocks of a plugin that is not enabled are pasted then they and their links are left out', () => {
      const json = envelope({
        blocks: [
          block({ id: 'p', type: 'acme.timer', props: {} }),
          block({ id: 's', parent: 'p' }),
        ],
        connectors: [
          { id: 'c', from: { block: 'p', anchor: 'auto' }, to: { block: 's', anchor: 'auto' } },
          { id: 'f', from: { x: 0, y: 0 }, to: { block: 's', anchor: 'auto' } },
        ],
      });

      const parsed = parseClipboard(json);
      // enabled: the plugin block is kept, so a parent link to it is refused (not a frame)
      const enabled = parseClipboard(json.replace('"parent":"p"', '"parent":null'), {
        pluginTypes: new Set(['acme.timer']),
      });

      expect(
        parsed.content.blocks.map((b) => b.id),
        'plugin block left out',
      ).toEqual(['s']);
      expect(parsed.content.blocks[0]?.parent, 'its child loses the link').toBeNull();
      expect(
        parsed.content.connectors.map((c) => c.id),
        'its connector goes',
      ).toEqual(['f']);
      expect(parsed.skippedTypes, 'counted').toBe(1);
      expect(enabled.content.blocks.length, 'enabled plugin: kept').toBe(2);
    });

    it('when a plugin block carries text then the text is dropped, built-in blocks keep theirs', () => {
      const json = envelope({
        blocks: [
          block({ id: 'p', type: 'acme.timer', props: {}, text: 'smuggled' }),
          block({ id: 's', text: 'kept' }),
        ],
      });

      const { content } = parseClipboard(json, { pluginTypes: new Set(['acme.timer']) });

      expect(
        content.blocks.find((b) => b.id === 'p')?.text,
        'plugin block: no text',
      ).toBeUndefined();
      expect(content.blocks.find((b) => b.id === 's')?.text, 'sticky: text').toBe('kept');
    });

    it('when an enabled plugin block has props that break the plugin rules then the paste is refused', () => {
      const types = new Set(['acme.timer', 'core.fake']);
      const proto = JSON.stringify({ a: 1 }).replace('"a"', '"__proto__"');
      const withProto = envelope({}).replace(
        '"props":{"color":"#fde68a"}',
        `"type":"acme.timer","props":${proto}`,
      );
      const huge = envelope({
        blocks: [block({ type: 'acme.timer', props: { blob: 'x'.repeat(70_000) } })],
      });

      expect(refusal(withProto, types), '__proto__ key').toContain('plain JSON');
      expect(refusal(huge, types), 'over 64 KiB').toContain('64 KiB');
      expect(
        parseClipboard(envelope({ blocks: [block({ type: 'core.fake', props: {} })] }), {
          pluginTypes: types,
        }).content.blocks,
        'a core type is never a plugin type',
      ).toEqual([]);
    });

    it('when the content holds more than 2000 blocks then it is refused', () => {
      const blocks = Array.from({ length: CLIPBOARD_LIMITS.maxBlocks + 1 }, (_, i) =>
        block({ id: `b${i}`, text: '' }),
      );

      expect(refusal(envelope({ blocks })), 'limit').toContain('more than 2000 blocks');
    });

    it('when a story card is pasted then its planning poker round id is dropped', () => {
      const parsed = parseClipboard(
        envelope({
          blocks: [
            block({
              type: STORY_TYPE,
              props: {
                description: '',
                criteria: [],
                estimate: null,
                pokerRoundId: '0192aaaa-0000-7000-8000-000000000001',
              },
            }),
          ],
        }),
      );

      expect(Object.keys(parsed.content.blocks[0]?.props ?? {}), 'no round id').not.toContain(
        'pokerRoundId',
      );
    });
  });

  describe('pasteClipboard', () => {
    function parsed(content: Record<string, unknown>, source: string | null = SOURCE) {
      return parseClipboard(envelope(content, { sourceBoard: source })) as ClipboardEnvelope;
    }

    it('when content is pasted then it gets new ids, remapped references and is centred on the point', () => {
      const env = parsed({
        blocks: [block({ id: 'a', x: 0, y: 0 }), block({ id: 'b', x: 200, y: 0, z: 0 })],
        connectors: [
          { id: 'c', from: { block: 'a', anchor: 'auto' }, to: { block: 'b', anchor: 'left' } },
        ],
        strokes: [{ id: 's', points: [0, 0, 0.5, 300, 100, 0.5], style: {} }],
      });
      sticky(0, 0); // existing content: the paste goes above it

      const result = pasteClipboard(board, env, { at: { x: 1000, y: 1000 }, targetBoard: SOURCE });

      expect(result.ids.length, 'block, block, connector, stroke').toBe(4);
      expect(result.ids, 'new ids').not.toContain('a');
      const [first, second] = result.ids.map((id) => board.getBlock(id));
      expect(first?.x, 'centred: bounds 0..300 x 0..100 around 1000,1000').toBe(1050);
      expect(first?.y, 'y').toBe(950);
      expect(second?.x, 'relative layout kept').toBe(850);
      expect(Math.min(first?.z ?? 0, second?.z ?? 0), 'above existing').toBeGreaterThan(1);
      expect((first?.z ?? 0) < (second?.z ?? 0), 'original order kept (b was below a)').toBe(true);
      const connector = board.getConnector(result.ids[2] ?? '');
      expect(connector?.to, 'end remapped').toEqual({
        block: [...result.ids].find((id) => board.getBlock(id)?.x === 1050) ?? '',
        anchor: 'left',
      });
      expect(board.getStroke(result.ids[3] ?? '')?.points.slice(0, 2), 'stroke moved').toEqual([
        850, 950,
      ]);
    });

    it('when a child is pasted with its parent then the link points to the new parent', () => {
      const env = parsed({
        blocks: [
          block({ id: 'p', type: 'core.frame', props: {}, text: 'Frame' }),
          block({ id: 'c', parent: 'p' }),
        ],
      });

      const result = pasteClipboard(board, env, { at: { x: 0, y: 0 }, targetBoard: SOURCE });

      const child = result.ids.map((id) => board.getBlock(id)).find((b) => b?.parent);
      expect(child?.parent, 'remapped parent').toBe(result.ids[0]);
      expect(result.topLevel, 'top level').toEqual([result.ids[0]]);
    });

    it('when file blocks come from this board then they are pasted, from another board they are left out', () => {
      const content = {
        blocks: [
          block({ id: 'f', type: 'core.file', props: { fileId: FILE_ID }, text: undefined }),
          block({ id: 's' }),
        ],
        connectors: [
          { id: 'c', from: { block: 'f', anchor: 'auto' }, to: { block: 's', anchor: 'auto' } },
        ],
      };

      const same = pasteClipboard(board, parsed(content), {
        at: { x: 0, y: 0 },
        targetBoard: SOURCE,
      });
      const other = pasteClipboard(board, parsed(content), {
        at: { x: 0, y: 0 },
        targetBoard: OTHER,
      });
      const unknown = pasteClipboard(board, parsed(content, null), {
        at: { x: 0, y: 0 },
        targetBoard: null,
      });

      expect(same.ids.length, 'same board: file, sticky, connector').toBe(3);
      expect(same.droppedFiles, 'none dropped').toBe(0);
      expect(other.ids.length, 'other board: only the sticky').toBe(1);
      expect(other.droppedFiles, 'one dropped').toBe(1);
      expect(unknown.droppedFiles, 'no board id: dropped as well').toBe(1);
    });

    it('when only files would be pasted into another board then nothing is written', () => {
      const env = parsed({
        blocks: [block({ type: 'core.file', props: { fileId: FILE_ID }, text: undefined })],
      });

      const result = pasteClipboard(board, env, { at: { x: 0, y: 0 }, targetBoard: OTHER });

      expect(result.ids, 'nothing').toEqual([]);
      expect(board.blocks().length, 'board unchanged').toBe(0);
    });
  });
});
