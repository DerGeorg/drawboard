import { FRAME_TITLE_MAX } from '@apps/drawboard-engine';
import { frameZIndex } from './renderer/renderer';
import { TestEngine, createTestEngine } from './testing/helpers';

describe('BoardEngine frames', () => {
  let t: TestEngine;
  beforeEach(() => (t = createTestEngine()));
  afterEach(() => t.destroy());

  const frame = (x = 0, y = 0, w = 400, h = 300, parent: string | null = null): string =>
    t.board.addBlock({
      type: 'core.frame',
      x,
      y,
      w,
      h,
      parent,
      props: { fill: '#ffffff' },
      text: 'Frame 1',
    });
  const sticky = (x: number, y: number, parent: string | null = null): string =>
    t.board.addBlock({ type: 'core.sticky', x, y, w: 50, h: 50, parent, text: 'n' });

  describe('rendering', () => {
    it('when a frame is rendered then it shows its title and a safe fill in the frames layer', () => {
      const id = frame();
      t.board.setProp(id, 'fill', 'url(https://evil.example/x.png)');
      const note = sticky(10, 50, id);
      t.engine.flush();

      const el = t.engine.blockElement(id);
      expect(el?.parentElement?.className, 'frames layer').toBe('be-frames');
      expect(t.engine.blockElement(note)?.parentElement?.className, 'others above').toBe(
        'be-blocks',
      );
      expect(el?.querySelector('.be-frame-title')?.textContent, 'title').toBe('Frame 1');
      expect((el?.querySelector('.be-frame') as HTMLElement).style.background, 'fill (S5.2)').toBe(
        'rgb(255, 255, 255)',
      );
    });

    it('when frames nest then the inner one paints above the outer one, whatever their z', () => {
      const outer = frame(0, 0, 800, 800);
      const inner = frame(10, 50, 300, 300, outer);
      t.board.transact(() => t.board.blocksMap.get(outer)?.set('z', 500));

      const z = (id: string): number => Number(t.engine.blockElement(id)?.style.zIndex);
      expect(z(inner) > z(outer), 'inner above').toBe(true);
      t.board.deleteItems([outer]);
      expect(z(inner), 'top-level again').toBe(frameZIndex(1, t.board.getBlock(inner)?.z ?? 0));
    });

    it('when a frame has no title then it says Frame, and a long one is cut', () => {
      const id = t.board.addBlock({ type: 'core.frame', x: 0, y: 0, w: 100, h: 100, text: '' });
      const long = t.board.addBlock({
        type: 'core.frame',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        text: 'x'.repeat(500),
      });

      expect(t.engine.blockElement(id)?.textContent, 'placeholder').toBe('Frame');
      expect(t.engine.blockElement(long)?.textContent?.length, 'cut').toBe(FRAME_TITLE_MAX);
    });
  });

  describe('selecting', () => {
    it('when the empty inside or the title of a frame is clicked then the frame is selected', () => {
      const id = frame();

      t.click(200, 200);
      expect(t.engine.selection.list(), 'inside').toEqual([id]);
      t.engine.selection.clear();
      t.click(200, 10);
      expect(t.engine.selection.list(), 'title').toEqual([id]);
    });

    it('when a block inside a frame is clicked then the block is selected, not the frame', () => {
      const id = frame();
      const note = sticky(100, 100, id);

      t.click(120, 120);

      expect(t.engine.selection.list(), 'the note').toEqual([note]);
    });

    it('when a drag starts in the empty inside of an unselected frame then it selects what is in it', () => {
      const id = frame();
      const note = sticky(100, 100, id);

      t.drag({ x: 50, y: 60 }, { x: 300, y: 250 });

      expect(t.engine.selection.list(), 'the note, not the frame').toEqual([note]);
      expect(t.board.getBlock(id)?.x, 'the frame did not move').toBe(0);
    });

    it('when a marquee covers a whole frame then the frame is selected too', () => {
      const id = frame(100, 100, 100, 100);

      t.drag({ x: 50, y: 50 }, { x: 250, y: 250 });

      expect(t.engine.selection.list(), 'frame').toContain(id);
    });
  });

  describe('moving', () => {
    it('when a frame is dragged by its title then everything inside follows in one undo step', () => {
      const outer = frame(0, 0, 800, 800);
      const inner = frame(100, 100, 300, 300, outer);
      const note = sticky(150, 200, inner);
      const outside = sticky(2000, 2000);
      t.engine.stopCapturing();

      t.drag({ x: 400, y: 10 }, { x: 500, y: 60 });

      expect(t.board.getBlock(outer)?.x, 'frame moved').toBe(100);
      expect(t.board.getBlock(inner)?.y, 'inner frame followed').toBe(150);
      expect(t.board.getBlock(note), 'note followed').toMatchObject({
        x: 250,
        y: 250,
        parent: inner,
      });
      expect(t.board.getBlock(outside)?.x, 'outside stayed').toBe(2000);
      t.engine.undo();
      expect(t.board.getBlock(note)?.x, 'one undo step').toBe(150);
      expect(t.board.getBlock(outer)?.x, 'frame back').toBe(0);
    });

    it('when a block is dropped onto a frame and dragged out again then it joins and leaves it', () => {
      const id = frame();
      const note = sticky(600, 600);

      t.drag({ x: 625, y: 625 }, { x: 200, y: 200 });
      expect(t.board.getBlock(note)?.parent, 'joined').toBe(id);
      t.drag({ x: 200, y: 200 }, { x: 900, y: 900 });
      expect(t.board.getBlock(note)?.parent, 'left').toBeNull();
    });

    it('when a selected frame is moved with the arrow keys then its content moves and stays in it', () => {
      const id = frame();
      const note = sticky(100, 100, id);
      t.engine.selection.set([id]);

      t.key('ArrowRight', { shift: true });

      expect(t.board.getBlock(id)?.x, 'frame').toBe(10);
      expect(t.board.getBlock(note), 'note').toMatchObject({ x: 110, parent: id });
    });

    it('when a frame is resized smaller then children outside keep their parent and do not move', () => {
      const id = frame(0, 0, 400, 300);
      const note = sticky(300, 200, id);
      t.engine.selection.set([id]);
      t.engine.flush();

      // the south-east handle of the frame (camera 1:1 at the origin)
      t.drag({ x: 400, y: 300 }, { x: 200, y: 150 });

      expect(t.board.getBlock(id)?.w, 'resized').toBe(200);
      expect(t.board.getBlock(note), 'note unchanged').toMatchObject({
        x: 300,
        y: 200,
        parent: id,
      });
    });

    it('when a frame is resized over a loose block then it takes it in', () => {
      const id = frame(0, 0, 200, 200);
      const note = sticky(300, 300);
      t.engine.selection.set([id]);
      t.engine.flush();

      t.drag({ x: 200, y: 200 }, { x: 500, y: 500 });

      expect(t.board.getBlock(note)?.parent, 'taken in').toBe(id);
    });
  });

  describe('creating', () => {
    it('when a frame is drawn around blocks then they become its children, one undo step', () => {
      const note = sticky(100, 100);
      t.engine.stopCapturing();
      t.engine.setTool('frame');

      t.drag({ x: 0, y: 0 }, { x: 500, y: 400 });

      const created = t.board.blocks().find((b) => b.type === 'core.frame');
      expect(created, 'frame').toMatchObject({ x: 0, y: 0, w: 500, h: 400 });
      expect(t.board.textOf(created?.id ?? ''), 'numbered title').toBe('Frame 1');
      expect(t.board.getBlock(note)?.parent, 'adopted').toBe(created?.id);
      expect(t.engine.tool, 'back to select').toBe('select');
      t.engine.undo();
      expect(t.board.getBlock(note)?.parent, 'undo: not adopted').toBeNull();
      expect(t.board.blocks().length, 'undo: frame gone').toBe(1);
    });

    it('when F is pressed then the frame tool is active', () => {
      expect(t.key('f'), 'handled').toBe(true);
      expect(t.engine.tool, 'frame tool').toBe('frame');
    });

    it('when a block is created or inserted inside a frame then it belongs to it', () => {
      const id = frame();
      t.engine.setTool('sticky');
      t.click(100, 100);
      t.engine.flush();
      const inserted = t.engine.insertBlock({ type: 'core.text', at: { x: 300, y: 200 } });

      const created = t.board.blocks().find((b) => b.type === 'core.sticky');
      expect(created?.parent, 'created').toBe(id);
      expect(t.board.getBlock(inserted ?? '')?.parent, 'inserted').toBe(id);
    });

    it('when content is pasted onto a frame then its top-level blocks join the frame', () => {
      const id = frame();
      t.engine.selection.set([sticky(2000, 2000)]);
      const json = t.engine.copySelection()?.json;
      t.engine.pointerMove(t.at(200, 200, { buttons: 0 }));

      t.engine.paste({ json });

      const pasted = t.board.getBlock(t.engine.selection.list()[0] ?? '');
      expect(pasted?.parent, 'in the frame').toBe(id);
    });
  });

  describe('deleting and duplicating', () => {
    it('when a frame is deleted then everything inside it goes too, one undo step', () => {
      const id = frame();
      const note = sticky(100, 100, id);
      t.engine.stopCapturing();
      t.engine.selection.set([id]);

      t.key('Delete');

      expect(t.board.blocks().length, 'all gone').toBe(0);
      t.engine.undo();
      expect(t.board.getBlock(note)?.parent, 'back with its parent').toBe(id);
      t.engine.selection.set([id]);
      t.engine.deleteSelection();
      expect(t.board.blocks().length, 'context toolbar delete as well').toBe(0);
    });

    it('when a frame with more than 10 blocks inside is deleted then a notice says how many and how to undo', () => {
      const notices: string[] = [];
      t.engine.clipboardNotice.on((m) => notices.push(m));
      const id = frame(0, 0, 2000, 2000);
      for (let i = 0; i < 11; i++) {
        sticky(10 + i * 60, 100, id);
      }
      t.engine.selection.set([id]);

      t.key('Delete');

      expect(t.board.blocks().length, 'all gone').toBe(0);
      expect(notices, 'one notice').toEqual(['12 items deleted - Ctrl+Z to undo']);

      t.engine.undo();
      t.engine.selection.set([id]);
      t.engine.deleteSelection();
      expect(notices[1], 'the toolbar delete as well').toBe('12 items deleted - Ctrl+Z to undo');
    });

    it('when a frame with 10 or fewer blocks inside is deleted then nothing is announced', () => {
      const notices: string[] = [];
      t.engine.clipboardNotice.on((m) => notices.push(m));
      const id = frame(0, 0, 2000, 2000);
      for (let i = 0; i < 10; i++) {
        sticky(10 + i * 60, 100, id);
      }
      t.engine.selection.set([id]);

      t.key('Delete');

      expect(t.board.blocks().length, 'all gone').toBe(0);
      expect(notices, 'silent').toEqual([]);
    });

    it('when "remove frame, keep contents" is used then only the frame goes', () => {
      const id = frame();
      const note = sticky(100, 100, id);
      t.engine.selection.set([id, note]);

      expect(t.engine.selectedFrames(), 'frames').toEqual([id]);
      t.engine.removeSelectedFrames();

      expect(t.board.hasBlock(id), 'frame gone').toBe(false);
      expect(t.board.getBlock(note)?.parent, 'note kept, top level').toBeNull();
      t.engine.undo();
      expect(t.board.hasBlock(id), 'one undo step').toBe(true);
    });

    it('when a frame is duplicated then its content is copied into the copy', () => {
      const id = frame();
      sticky(100, 100, id);
      t.engine.selection.set([id]);

      t.key('d', { mod: true });

      const copy = t.engine.selection.list()[0] ?? '';
      expect(copy, 'a new frame').not.toBe(id);
      const inCopy = t.board.blocks().filter((b) => b.parent === copy);
      expect(
        inCopy.map((b) => b.type),
        'the copied note is in the copy',
      ).toEqual(['core.sticky']);
    });

    it('when a block inside a frame is duplicated then the copy stays in the same frame', () => {
      const id = frame();
      const note = sticky(100, 100, id);
      t.engine.selection.set([note]);

      t.engine.duplicateSelection();

      const copy = t.board.getBlock(t.engine.selection.list()[0] ?? '');
      expect(copy?.parent, 'same frame').toBe(id);
    });

    it('when a frame is cut then its content goes along and comes back with paste', () => {
      const id = frame();
      sticky(100, 100, id);
      t.engine.selection.set([id]);

      const content = t.engine.cutSelection();
      t.engine.paste({ json: content?.json });

      const frames = t.board.blocks().filter((b) => b.type === 'core.frame');
      expect(frames.length, 'one frame').toBe(1);
      expect(
        t.board.blocks().filter((b) => b.parent === frames[0]?.id).length,
        'with its note',
      ).toBe(1);
    });
  });

  describe('title', () => {
    it('when a frame is double-clicked then its title is edited in the title strip, one line, at most 200', () => {
      const id = frame();

      t.engine.doubleClick(t.at(200, 10));

      const editor = t.engine
        .blockElement(id)
        ?.querySelector<HTMLTextAreaElement>('[data-be-text-host] textarea');
      expect(editor, 'editor in the strip').not.toBeNull();
      expect(editor?.maxLength, 'limit').toBe(FRAME_TITLE_MAX);
      if (editor) {
        editor.value = 'Sys\ntem';
        editor.dispatchEvent(new Event('input'));
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
      expect(t.board.textOf(id), 'one line').toBe('Sys tem');
      expect(editor?.isConnected, 'Enter ends the edit').toBe(false);
    });
  });

  describe('selection kind', () => {
    it('when frames are selected then the kind is frame and the fill can be styled', () => {
      const id = frame();
      t.engine.selection.set([id]);

      t.engine.setStyleForSelection({ fill: '#fde68a' });

      expect(t.engine.selectionKind(), 'kind').toBe('frame');
      expect(t.engine.selectionStyle().fill, 'fill').toBe('#fde68a');
    });
  });
});
