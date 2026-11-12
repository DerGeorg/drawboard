import { CLIPBOARD_LIMITS, CLIPBOARD_MIME } from './io/clipboard';
import { BlockType } from './renderer/block-registry';
import { TestEngine, createTestEngine } from './testing/helpers';

const BOARD = '0192bbbb-0000-7000-8000-00000000b0a2';
const OTHER = '0192bbbb-0000-7000-8000-00000000c0c3';
const FILE_ID = '0192aaaa-0000-7000-8000-0000000000f1';

const timer: BlockType = {
  type: 'acme.timer',
  label: 'Timer',
  defaultSize: { w: 10, h: 10 },
  defaultProps: {},
  render: () => ({ update: () => undefined, destroy: () => undefined }),
};

describe('BoardEngine clipboard', () => {
  let t: TestEngine;
  let notices: string[];

  function start(options: { readOnly?: boolean; boardId?: string | null } = {}): void {
    t = createTestEngine({ boardId: BOARD, ...options });
    notices = [];
    t.engine.clipboardNotice.on((m) => notices.push(m));
  }

  afterEach(() => t.destroy());

  function sticky(x = 0, y = 0, text = 'note'): string {
    return t.board.addBlock({
      type: 'core.sticky',
      x,
      y,
      w: 100,
      h: 100,
      props: { color: '#fde68a' },
      text,
    });
  }

  /** Moves the pointer over the board to a world point. */
  function pointAt(x: number, y: number): void {
    t.engine.pointerMove(t.at(x, y, { buttons: 0 }));
  }

  describe('copy', () => {
    it('when blocks are selected and copied then the content holds them and the board is unchanged', () => {
      start();
      const id = sticky(0, 0, 'hello');
      t.engine.selection.set([id]);

      const content = t.engine.copySelection();

      expect(content?.text, 'plain text').toBe('hello');
      expect(content?.json, 'source board').toContain(BOARD);
      expect(t.board.blocks().length, 'unchanged').toBe(1);
    });

    it('when nothing is selected then nothing is copied', () => {
      start();

      expect(t.engine.copySelection(), 'nothing').toBeUndefined();
    });

    it('when the board is read-only then copying works but cutting does nothing', () => {
      start({ readOnly: true });
      const id = sticky();
      t.engine.selection.set([id]);

      expect(t.engine.copySelection(), 'copy').toBeDefined();
      expect(t.engine.cutSelection(), 'no cut').toBeUndefined();
      expect(t.board.hasBlock(id), 'still there').toBe(true);
    });

    it('when the selection is too large then a notice explains it', () => {
      // a small limit instead of 2001 stickies: building those took over 5 s on a busy CI runner
      const limits = CLIPBOARD_LIMITS as { -readonly [K in keyof typeof CLIPBOARD_LIMITS]: number };
      const before = limits.maxBlocks;
      limits.maxBlocks = 3;
      try {
        start();
        const ids = [0, 1, 2, 3].map((i) => sticky(i * 200, 0, ''));
        t.engine.selection.set(ids);

        expect(t.engine.copySelection(), 'nothing').toBeUndefined();
        expect(notices[0], 'notice').toContain('too large');
      } finally {
        limits.maxBlocks = before;
      }
    });
  });

  describe('cut', () => {
    it('when blocks are cut then they are deleted as one undo step and come back with undo', () => {
      start();
      const a = sticky(0, 0);
      const b = sticky(200, 0);
      t.board.addConnector({ block: a, anchor: 'auto' }, { block: b, anchor: 'auto' });
      t.engine.stopCapturing();
      t.engine.selection.set([a, b]);

      const content = t.engine.cutSelection();

      expect(content?.json, 'copied').toContain('"connectors":[{');
      expect(t.board.blocks().length, 'cut').toBe(0);
      expect(t.engine.selection.size, 'selection cleared').toBe(0);
      t.engine.undo();
      expect(t.board.blocks().length, 'one undo brings both back').toBe(2);
      expect(t.board.connectors().length, 'and the connector').toBe(1);
    });
  });

  describe('paste', () => {
    it('when copied content is pasted at the pointer then copies are centred there and selected', () => {
      start();
      const id = sticky(0, 0);
      t.engine.selection.set([id]);
      const content = t.engine.copySelection();
      pointAt(500, 300);

      const taken = t.engine.paste({ json: content?.json });

      const [pasted] = t.engine.selection.list();
      expect(taken, 'taken').toBe(true);
      expect(pasted, 'new id').not.toBe(id);
      expect(t.board.getBlock(pasted ?? ''), 'at the pointer').toMatchObject({ x: 450, y: 250 });
      expect(t.board.textOf(pasted ?? ''), 'text').toBe('note');
    });

    it('when the pointer is not over the board then the paste goes to the middle of the view', () => {
      start();
      t.engine.selection.set([sticky(800, 800)]);
      const content = t.engine.copySelection();
      pointAt(500, 300);
      t.engine.pointerLeave();

      t.engine.paste({ json: content?.json });

      const center = t.engine.visibleCenter();
      const pasted = t.board.getBlock(t.engine.selection.list()[0] ?? '');
      expect(pasted?.x, 'x').toBe(center.x - 50);
      expect(pasted?.y, 'y').toBe(center.y - 50);
    });

    it('when the same content is pasted again at the same spot then each copy steps by 20', () => {
      start();
      t.engine.selection.set([sticky()]);
      const json = t.engine.copySelection()?.json;
      pointAt(100, 100);

      const xs = [1, 2, 3].map(() => {
        t.engine.paste({ json });
        return t.board.getBlock(t.engine.selection.list()[0] ?? '')?.x;
      });
      pointAt(400, 100);
      t.engine.paste({ json });

      expect(xs, 'stepped').toEqual([50, 70, 90]);
      expect(t.board.getBlock(t.engine.selection.list()[0] ?? '')?.x, 'new spot: no step').toBe(
        350,
      );
    });

    it('when a paste is undone then everything it added goes in one step', () => {
      start();
      const a = sticky(0, 0);
      const b = sticky(200, 0);
      t.board.addConnector({ block: a, anchor: 'auto' }, { block: b, anchor: 'auto' });
      t.engine.selection.set([a, b]);
      const json = t.engine.copySelection()?.json;
      t.engine.stopCapturing();

      t.engine.paste({ json });
      expect(t.board.blocks().length, 'pasted').toBe(4);
      t.engine.undo();

      expect(t.board.blocks().length, 'blocks gone').toBe(2);
      expect(t.board.connectors().length, 'connector gone').toBe(1);
    });

    it('when the board is read-only then nothing is pasted', () => {
      start({ readOnly: true });
      const json = JSON.stringify({ drawboard: 'clipboard', version: 1, content: {} });

      expect(t.engine.paste({ json, text: 'hi' }), 'not taken').toBe(false);
      expect(t.board.blocks().length, 'nothing').toBe(0);
    });

    it('when the clipboard content is invalid then nothing is pasted and a notice says why', () => {
      start();

      const taken = t.engine.paste({ json: '{"drawboard":"clipboard","version":7}' });

      expect(taken, 'taken (not pasted as text)').toBe(true);
      expect(t.board.blocks().length, 'nothing').toBe(0);
      expect(notices[0], 'why').toBe(
        'Nothing was pasted: the content comes from a newer version of Drawboard.',
      );
    });

    it('when content from another board holds a file then the file is left out with a notice', () => {
      start({ boardId: OTHER });
      const json = JSON.stringify({
        drawboard: 'clipboard',
        version: 1,
        sourceBoard: BOARD,
        content: {
          schemaVersion: 1,
          title: '',
          blocks: [
            { id: 'f', type: 'core.file', x: 0, y: 0, w: 100, h: 100, props: { fileId: FILE_ID } },
            { id: 's', type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, props: {}, text: 'x' },
          ],
        },
      });

      t.engine.paste({ json });

      expect(
        t.board.blocks().map((b) => b.type),
        'sticky only',
      ).toEqual(['core.sticky']);
      expect(notices[0], 'notice').toContain('1 file was left out');
    });

    it('when plugin blocks are pasted then only those of plugins enabled here are kept', () => {
      start();
      const json = JSON.stringify({
        drawboard: 'clipboard',
        version: 1,
        sourceBoard: BOARD,
        content: {
          schemaVersion: 1,
          title: '',
          blocks: [
            { id: 'a', type: 'acme.timer', x: 0, y: 0, w: 10, h: 10, props: { n: 1 } },
            { id: 'b', type: 'other.thing', x: 0, y: 0, w: 10, h: 10, props: {} },
          ],
        },
      });

      t.engine.paste({ json });
      expect(t.board.blocks().length, 'not enabled: nothing').toBe(0);
      expect(notices[0], 'notice').toContain('2 blocks of plugins');
      t.engine.registry.registerAll([timer]);
      t.engine.paste({ json });

      expect(
        t.board.blocks().map((b) => b.type),
        'enabled one kept',
      ).toEqual(['acme.timer']);
      expect(t.board.blocks()[0]?.props, 'props').toEqual({ n: 1 });
    });

    describe('when the largest allowed envelope is pasted', () => {
      const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

      /** An envelope of `count` stickies whose JSON is as close to the byte limit as it gets. */
      function maximal(count: number, char: string): string {
        const make = (len: number): string =>
          JSON.stringify({
            drawboard: 'clipboard',
            version: 1,
            sourceBoard: BOARD,
            content: {
              schemaVersion: 1,
              title: '',
              blocks: Array.from({ length: count }, (_, i) => ({
                id: `s${i}`,
                type: 'core.sticky',
                x: i,
                y: 0,
                w: 100,
                h: 100,
                props: { color: '#fde68a' },
                text: char.repeat(len),
              })),
            },
          });
        const free = CLIPBOARD_LIMITS.maxBytes - bytesOf(make(0));
        return make(Math.floor(free / count / bytesOf(char)));
      }

      it.each([
        ['2000 stickies with ascii texts', 2000, 'x'],
        ['2000 stickies with three-byte characters', 2000, '\u20ac'],
        ['6 stickies with long texts', 6, 'x'],
      ])(
        'when the largest envelope with %s is pasted then every Yjs update stays below 1 MiB',
        (_label, count, char) => {
          start();
          const json = maximal(count, char);
          const sizes: number[] = [];
          t.board.doc.on('update', (u: Uint8Array) => sizes.push(u.byteLength));

          const taken = t.engine.paste({ json });

          expect(bytesOf(json), 'envelope at the limit').toBeLessThanOrEqual(
            CLIPBOARD_LIMITS.maxBytes,
          );
          expect(taken, 'taken').toBe(true);
          expect(t.board.blocks().length, 'all pasted').toBe(count);
          expect(sizes.length, 'at least one update').toBeGreaterThan(0);
          for (const size of sizes) {
            expect(size, 'update size').toBeLessThan(1_048_576);
          }
        },
        // the maximal envelope is the point of this test; it takes several seconds on a busy runner
        30_000,
      );
    });

    it('when plain text is pasted then it becomes one sticky note at the pointer', () => {
      start();
      pointAt(0, 0);

      t.engine.paste({ text: 'from outside\nsecond line' });
      const taken = t.engine.paste({ text: '   ' });

      const [note] = t.board.blocks();
      expect(note?.type, 'a sticky').toBe('core.sticky');
      expect(t.board.textOf(note?.id ?? ''), 'whole text').toBe('from outside\nsecond line');
      expect(t.engine.selection.list(), 'selected').toEqual([note?.id]);
      expect(taken, 'blank text is not taken').toBe(false);
      expect(t.board.blocks().length, 'one note').toBe(1);
    });

    it('when very long text is pasted then the note holds at most 100 000 characters', () => {
      start();

      t.engine.paste({ text: 'x'.repeat(120_000) });

      expect(t.board.textOf(t.board.blocks()[0]?.id ?? '').length, 'capped').toBe(100_000);
    });
  });

  describe('clipboard events', () => {
    function clipboardEvent(
      type: string,
      data: Record<string, string> = {},
    ): { event: Event; written: Record<string, string> } {
      const written: Record<string, string> = {};
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, {
        clipboardData: {
          types: Object.keys(data),
          files: [],
          getData: (k: string) => data[k] ?? '',
          setData: (k: string, v: string) => (written[k] = v),
        },
      });
      return { event, written };
    }

    it('when the board copies and pastes through real events then the block is duplicated', () => {
      start();
      t.engine.selection.set([sticky(0, 0, 'event')]);
      const copy = clipboardEvent('copy');

      t.container.dispatchEvent(copy.event);
      const paste = clipboardEvent('paste', {
        [CLIPBOARD_MIME]: copy.written[CLIPBOARD_MIME] ?? '',
        'text/plain': copy.written['text/plain'] ?? '',
      });
      t.container.dispatchEvent(paste.event);

      expect(copy.event.defaultPrevented, 'copy taken').toBe(true);
      expect(copy.written['text/plain'], 'text fallback').toBe('event');
      expect(paste.event.defaultPrevented, 'paste taken').toBe(true);
      expect(t.board.blocks().length, 'two notes').toBe(2);
    });

    it('when a cut event reaches the board then the selection is cut', () => {
      start();
      t.engine.selection.set([sticky()]);
      const cut = clipboardEvent('cut');

      t.container.dispatchEvent(cut.event);

      expect(cut.written[CLIPBOARD_MIME], 'written').toContain('"drawboard":"clipboard"');
      expect(t.board.blocks().length, 'gone').toBe(0);
    });
  });
});
