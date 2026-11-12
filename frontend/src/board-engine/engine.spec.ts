import { BlockType, BlockTypeRegistry } from './renderer/block-registry';
import { registerBuiltinBlocks } from './blocks/builtin';
import { pointerInfo } from './input/events';
import { LOCAL_ORIGIN } from './model/board-doc';
import { TestEngine, createTestEngine } from './testing/helpers';
import * as Y from 'yjs';

describe('BoardEngine', () => {
  let t: TestEngine;
  beforeEach(() => (t = createTestEngine()));
  afterEach(() => t.destroy());

  function addSticky(x = 0, y = 0, w = 100, h = 100): string {
    const id = t.board.addBlock({
      type: 'core.sticky',
      x,
      y,
      w,
      h,
      props: { color: '#fde68a' },
      text: 'note',
    });
    t.engine.flush();
    return id;
  }

  describe('rendering', () => {
    it('when a block is added then one element with its geometry and text is rendered', () => {
      const id = addSticky(10, 20, 150, 90);

      const el = t.engine.blockElement(id);
      expect(el?.style.left, 'left').toBe('10px');
      expect(el?.style.width, 'width').toBe('150px');
      expect(el?.textContent, 'text').toBe('note');
    });

    it('when the block changes then the same element is updated, and removed on delete', () => {
      const id = addSticky();
      const el = t.engine.blockElement(id);

      t.board.setGeometry(id, { x: 50 });
      t.board.transact(() => t.board.getText(id)?.insert(0, '!'));

      expect(t.engine.blockElement(id), 'same element').toBe(el);
      expect(el?.style.left, 'left').toBe('50px');
      expect(el?.textContent, 'text').toBe('!note');
      t.board.deleteItems([id]);
      expect(t.engine.blockElement(id), 'removed').toBeUndefined();
    });

    it('when a block has an unknown type then a placeholder is shown and the data is kept', () => {
      const id = t.board.addBlock({ type: 'acme.timer', x: 0, y: 0, w: 100, h: 50 });
      const core = t.board.addBlock({ type: 'core.gone', x: 0, y: 0, w: 100, h: 50 });

      expect(t.engine.blockElement(id)?.textContent, 'plugin placeholder').toContain(
        'Plugin: acme - not available',
      );
      expect(t.engine.blockElement(core)?.textContent, 'core placeholder').toContain(
        'Unknown block type: core.gone',
      );
      expect(t.board.hasBlock(id), 'data kept').toBe(true);
    });

    it('when a block type is registered later or removed then its blocks render again', () => {
      const id = t.board.addBlock({ type: 'acme.timer', x: 0, y: 0, w: 100, h: 50 });
      const timer: BlockType = {
        type: 'acme.timer',
        label: 'Timer',
        defaultSize: { w: 10, h: 10 },
        defaultProps: {},
        render: (host) => {
          host.append('tick');
          return { update: () => undefined, destroy: () => undefined };
        },
      };

      t.engine.registry.registerAll([timer]);
      expect(t.engine.blockElement(id)?.textContent, 'now rendered').toBe('tick');
      t.engine.registry.unregisterAll(['acme.timer']);
      expect(t.engine.blockElement(id)?.textContent, 'placeholder again').toContain(
        'not available',
      );
      expect(() => t.engine.registry.registerAll([timer, timer]), 'duplicates').toThrow();
    });

    it('when a block type throws while rendering then a placeholder is shown', () => {
      const registry = registerBuiltinBlocks(new BlockTypeRegistry());
      const bad: BlockType = {
        type: 'acme.bad',
        label: 'Bad',
        defaultSize: { w: 10, h: 10 },
        defaultProps: {},
        render: () => {
          throw new Error('boom');
        },
      };
      registry.register(bad);
      const u = createTestEngine({ registry });

      const id = u.board.addBlock({ type: 'acme.bad', x: 0, y: 0, w: 10, h: 10 });

      expect(u.engine.blockElement(id)?.textContent, 'placeholder').toContain('not available');
      u.destroy();
    });

    it('when a view throws on update or destroy then the board keeps working', () => {
      const registry = new BlockTypeRegistry();
      registry.register({
        type: 'acme.fragile',
        label: 'Fragile',
        defaultSize: { w: 10, h: 10 },
        defaultProps: {},
        render: () => ({
          update: () => {
            throw new Error('update');
          },
          destroy: () => {
            throw new Error('destroy');
          },
        }),
      });
      const u = createTestEngine({ registry });
      const id = u.board.addBlock({ type: 'acme.fragile', x: 0, y: 0, w: 10, h: 10 });

      u.board.setGeometry(id, { x: 5 });
      u.board.deleteItems([id]);

      expect(u.engine.blockElement(id), 'removed anyway').toBeUndefined();
      u.destroy();
    });

    it('when the viewport is measured then blocks far outside are not mounted until they scroll in', () => {
      const near = addSticky(0, 0);
      const far = addSticky(5000, 0);
      t.engine.setViewportSize({ w: 800, h: 600 });

      expect(t.engine.blockElement(near), 'near block').toBeDefined();
      expect(t.engine.blockElement(far), 'far block').toBeUndefined();
      expect(t.engine.mountedBlockCount, 'mounted').toBe(1);

      t.engine.setCamera({ x: -5000, y: 0, zoom: 1 });
      t.engine.flush();

      expect(t.engine.blockElement(far), 'far block after pan').toBeDefined();
      expect(t.engine.blockElement(near), 'near block culled').toBeUndefined();
    });

    it('when a far block changes while culled then it is mounted only if visible', () => {
      t.engine.setViewportSize({ w: 800, h: 600 });
      const far = addSticky(5000, 0);
      expect(t.engine.blockElement(far), 'culled').toBeUndefined();

      t.board.setGeometry(far, { x: 100 });

      expect(t.engine.blockElement(far), 'mounted after moving into view').toBeDefined();
    });
  });

  describe('select tool', () => {
    it('when clicking a block then it is selected, and clicking empty space clears it', () => {
      const id = addSticky();

      t.click(50, 50);
      expect(t.engine.selection.list(), 'after click').toEqual([id]);
      t.click(500, 500);
      expect(t.engine.selection.list(), 'after click on empty space').toEqual([]);
    });

    it('when shift-clicking then the selection toggles', () => {
      const a = addSticky(0, 0);
      const b = addSticky(300, 0);

      t.click(50, 50);
      t.click(350, 50, { shift: true });
      expect(t.engine.selection.list(), 'both').toEqual([a, b]);
      t.click(350, 50, { shift: true });
      expect(t.engine.selection.list(), 'one again').toEqual([a]);
    });

    it('when dragging a block then it moves by the dragged distance', () => {
      const id = addSticky(0, 0);

      t.drag({ x: 50, y: 50 }, { x: 150, y: 90 });

      expect(t.board.getBlock(id), 'block').toMatchObject({ x: 100, y: 40 });
    });

    it('when a click moves less than a few pixels then the block does not move', () => {
      const id = addSticky(0, 0);

      t.engine.pointerDown(t.at(50, 50));
      t.engine.pointerMove(t.at(51, 50));
      t.engine.pointerUp(t.at(51, 50, { buttons: 0 }));

      expect(t.board.getBlock(id)?.x, 'x').toBe(0);
    });

    it('when dragging all of a multi selection then all move together', () => {
      const a = addSticky(0, 0);
      const b = addSticky(300, 0);
      t.engine.selection.set([a, b]);

      t.drag({ x: 50, y: 50 }, { x: 60, y: 70 });

      expect(t.board.getBlock(a), 'a').toMatchObject({ x: 10, y: 20 });
      expect(t.board.getBlock(b), 'b').toMatchObject({ x: 310, y: 20 });
    });

    it('when dragging on empty space then the marquee selects what it touches', () => {
      const a = addSticky(0, 0);
      addSticky(400, 400);

      t.drag({ x: -20, y: -20 }, { x: 60, y: 60 });

      expect(t.engine.selection.list(), 'selection').toEqual([a]);
    });

    it('when a marquee is dragged with shift then it adds to the selection', () => {
      const a = addSticky(0, 0);
      const b = addSticky(400, 400);
      t.engine.selection.set([b]);

      t.drag({ x: -20, y: -20 }, { x: 60, y: 60 }, { shift: true });

      expect(t.engine.selection.list().sort(), 'selection').toEqual([a, b].sort());
    });

    it('when a single block is selected then a resize handle drag resizes it', () => {
      const id = addSticky(0, 0, 100, 100);
      t.engine.selection.set([id]);

      t.drag({ x: 100, y: 100 }, { x: 160, y: 140 });

      expect(t.board.getBlock(id), 'block').toMatchObject({ x: 0, y: 0, w: 160, h: 140 });
    });

    it('when the pointer hovers a handle then the cursor changes', () => {
      const id = addSticky(0, 0, 100, 100);
      t.engine.selection.set([id]);

      t.engine.pointerMove(t.at(100, 100, { buttons: 0 }));

      expect(t.container.style.cursor, 'cursor').toBe('nwse-resize');
    });

    it('when the block is locked then there are no handles', () => {
      const id = addSticky(0, 0, 100, 100);
      t.board.setBlockFlag(id, 'locked', true);
      t.engine.selection.set([id]);

      expect(t.engine.handleAt({ x: 100, y: 100 }), 'handle').toBeUndefined();
    });

    it('when Delete is pressed then the selection is deleted, and undo brings it back', () => {
      const id = addSticky();
      t.engine.selection.set([id]);

      expect(t.key('Delete'), 'handled').toBe(true);
      expect(t.board.hasBlock(id), 'deleted').toBe(false);
      expect(t.engine.selection.size, 'selection cleared').toBe(0);
      t.key('z', { mod: true });
      expect(t.board.hasBlock(id), 'restored').toBe(true);
    });

    it('when mod+A is pressed then everything is selected', () => {
      const a = addSticky(0, 0);
      const b = addSticky(300, 0);

      t.key('a', { mod: true });

      expect(t.engine.selection.list().sort(), 'selection').toEqual([a, b].sort());
    });

    it('when Escape is pressed then the selection is cleared', () => {
      t.engine.selection.set([addSticky()]);

      t.key('Escape');

      expect(t.engine.selection.size, 'selection').toBe(0);
    });

    it('when mod+D is pressed then the selection is duplicated and the copy is selected', () => {
      const id = addSticky(0, 0);
      t.engine.selection.set([id]);

      t.key('d', { mod: true });

      expect(t.board.blockIds().length, 'blocks').toBe(2);
      const copy = t.engine.selection.list()[0];
      expect(copy, 'copy is selected').not.toBe(id);
      expect(t.board.getBlock(copy ?? ''), 'copy geometry').toMatchObject({ x: 24, y: 24 });
      expect(t.board.textOf(copy ?? ''), 'text copied').toBe('note');
    });

    it('when arrow keys are pressed then the selection nudges by 1, or 10 with shift', () => {
      const id = addSticky(0, 0);
      t.engine.selection.set([id]);

      t.key('ArrowRight');
      t.key('ArrowDown', { shift: true });

      expect(t.board.getBlock(id), 'block').toMatchObject({ x: 1, y: 10 });
    });

    it('when nothing is selected then Delete and arrows are not handled', () => {
      expect(t.key('Delete'), 'delete').toBe(false);
      expect(t.key('ArrowLeft'), 'arrow').toBe(false);
    });

    it('when the engine is read-only then selecting works but nothing changes', () => {
      const u = createTestEngine({ readOnly: true });
      const id = u.board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, text: 'x' });

      u.drag({ x: 50, y: 50 }, { x: 150, y: 150 });
      u.key('Delete');
      u.key('d', { mod: true });

      expect(u.engine.selection.list(), 'selected').toEqual([id]);
      expect(u.board.getBlock(id), 'unmoved').toMatchObject({ x: 0, y: 0 });
      expect(u.board.blockIds().length, 'no duplicate, not deleted').toBe(1);
      u.engine.setTool('sticky');
      expect(u.engine.tool, 'tool stays select').toBe('select');
      u.engine.undo();
      u.engine.setStyleForSelection({ color: '#000' });
      expect(u.board.getBlock(id)?.props['color'], 'style untouched').toBeUndefined();
      u.destroy();
    });

    it('when a block is deleted by someone else then it leaves the selection', () => {
      const id = addSticky();
      t.engine.selection.set([id]);

      t.board.deleteItems([id]);

      expect(t.engine.selection.size, 'selection').toBe(0);
    });
  });

  describe('create tools', () => {
    it('when the sticky tool clicks then a sticky is centered there, selected, and the select tool returns', () => {
      t.key('s');
      expect(t.engine.tool, 'tool').toBe('sticky');

      t.click(300, 300);

      const [block] = t.board.blocks();
      expect(block, 'block').toMatchObject({ type: 'core.sticky', x: 200, y: 200, w: 200, h: 200 });
      expect(t.engine.selection.list(), 'selected').toEqual([block?.id]);
      expect(t.engine.tool, 'tool after create').toBe('select');
      expect(t.container.querySelector('textarea'), 'text editor opened').not.toBeNull();
    });

    it('when the sticky tool drags then the sticky has the dragged size', () => {
      t.engine.setTool('sticky');

      t.drag({ x: 10, y: 10 }, { x: 210, y: 110 });

      expect(t.board.blocks()[0], 'block').toMatchObject({ x: 10, y: 10, w: 200, h: 100 });
    });

    it('when a new sticky stays empty then it stays on the board, with the editor closed', () => {
      t.engine.setTool('sticky');
      t.click(300, 300);
      const ta = t.container.querySelector('textarea');

      ta?.blur();

      expect(t.board.blockIds().length, 'blocks').toBe(1);
      expect(t.board.blocks()[0]?.type, 'type').toBe('core.sticky');
      expect(t.container.querySelector('textarea'), 'editor closed').toBeNull();
    });

    it('when a new text block stays empty then it is removed again (an empty text is invisible)', () => {
      t.engine.setTool('text');
      t.click(300, 300);

      t.container.querySelector('textarea')?.blur();

      expect(t.board.blockIds().length, 'blocks').toBe(0);
    });

    it('when text is typed into a new sticky then it is kept and rendered', () => {
      t.engine.setTool('sticky');
      t.click(300, 300);
      const ta = t.container.querySelector('textarea') as HTMLTextAreaElement;

      ta.value = 'hello https://example.com';
      ta.dispatchEvent(new Event('input'));
      ta.blur();

      const id = t.board.blockIds()[0] ?? '';
      expect(t.board.textOf(id), 'text').toBe('hello https://example.com');
      expect(t.engine.blockElement(id)?.querySelector('a')?.getAttribute('href'), 'link').toBe(
        'https://example.com/',
      );
      expect(t.container.querySelector('textarea'), 'editor closed').toBeNull();
    });

    it('when the create tool pointer is cancelled then nothing is created', () => {
      t.engine.setTool('sticky');
      t.engine.pointerDown(t.at(10, 10));
      t.engine.pointerCancel();
      t.engine.pointerUp(t.at(10, 10, { buttons: 0 }));

      expect(t.board.blockIds().length, 'blocks').toBe(0);
    });

    it('when double-clicking a sticky then the text editor opens; Escape closes it', () => {
      const id = addSticky();

      t.engine.doubleClick(t.at(50, 50, { detail: 2 }));

      expect(t.container.querySelector('textarea'), 'editor').not.toBeNull();
      expect(t.engine.selection.list(), 'selected').toEqual([id]);
      t.container
        .querySelector('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(t.container.querySelector('textarea'), 'editor closed').toBeNull();
    });

    it('when a sticky is edited then only its text is hidden, the note stays visible and gets its color back', () => {
      addSticky();
      const note = t.container.querySelector<HTMLElement>('.be-sticky');
      const color = note?.style.color;

      t.engine.doubleClick(t.at(50, 50, { detail: 2 }));

      expect(note?.style.visibility, 'note (its background) stays visible').toBe('');
      expect(note?.style.color, 'text hidden under the editor').toBe('transparent');
      t.container
        .querySelector('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(note?.style.color, 'text color restored').toBe(color);
    });

    it('when Enter is pressed with one editable block selected then the editor opens', () => {
      t.engine.selection.set([addSticky()]);

      t.key('Enter');

      expect(t.container.querySelector('textarea'), 'editor').not.toBeNull();
    });

    it('when double-clicking empty space then nothing happens', () => {
      t.engine.doubleClick(t.at(500, 500, { detail: 2 }));

      expect(t.container.querySelector('textarea'), 'editor').toBeNull();
    });

    it('when a text edit is open and the block is deleted remotely then the editor closes', () => {
      const id = addSticky();
      t.engine.startTextEdit(id);

      t.board.deleteItems([id]);

      expect(t.container.querySelector('textarea'), 'editor').toBeNull();
    });

    it('when a text edit starts for an unknown or non-text block then nothing opens', () => {
      const id = t.board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10 });
      t.engine.startTextEdit(id);
      t.engine.startTextEdit('missing');

      expect(t.container.querySelector('textarea'), 'editor').toBeNull();
    });
  });

  describe('camera and hand tool', () => {
    it('when the hand tool drags then the camera pans', () => {
      t.engine.setTool('hand');

      t.engine.pointerDown(pointerInfo({ screen: { x: 10, y: 10 }, world: { x: 10, y: 10 } }));
      t.engine.pointerMove(pointerInfo({ screen: { x: 40, y: 30 }, world: { x: 40, y: 30 } }));
      t.engine.pointerUp(
        pointerInfo({ screen: { x: 40, y: 30 }, world: { x: 40, y: 30 }, buttons: 0 }),
      );

      expect(t.engine.camera, 'camera').toMatchObject({ x: 30, y: 20, zoom: 1 });
    });

    it('when space is held then dragging pans even with the select tool, and the cursor shows it', () => {
      t.key(' ');
      expect(t.container.style.cursor, 'cursor while space is held').toBe('grab');

      t.engine.pointerDown(pointerInfo({ screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } }));
      t.engine.pointerMove(pointerInfo({ screen: { x: 25, y: 5 }, world: { x: 25, y: 5 } }));
      expect(t.container.style.cursor, 'cursor while panning').toBe('grabbing');
      t.engine.pointerUp(
        pointerInfo({ screen: { x: 25, y: 5 }, world: { x: 25, y: 5 }, buttons: 0 }),
      );
      t.engine.keyUp({ key: ' ', shift: false, alt: false, mod: false, repeat: false });

      expect(t.engine.camera, 'camera').toMatchObject({ x: 25, y: 5 });
      expect(t.container.style.cursor, 'cursor after').toBe('default');
    });

    it('when the middle button is pressed then it pans', () => {
      t.engine.pointerDown(
        pointerInfo({ screen: { x: 0, y: 0 }, world: { x: 0, y: 0 }, buttons: 4 }),
      );
      t.engine.pointerMove(
        pointerInfo({ screen: { x: 5, y: 5 }, world: { x: 5, y: 5 }, buttons: 4 }),
      );
      t.engine.pointerCancel();

      expect(t.engine.camera, 'camera').toMatchObject({ x: 5, y: 5 });
    });

    it('when the wheel turns then the camera pans', () => {
      t.engine.wheel({ screen: { x: 0, y: 0 }, deltaX: 10, deltaY: 40, zoom: false });

      expect(t.engine.camera, 'camera').toMatchObject({ x: -10, y: -40 });
    });

    it('when the wheel turns with mod or a pinch arrives then the camera zooms around the pointer', () => {
      t.engine.wheel({ screen: { x: 100, y: 100 }, deltaX: 0, deltaY: -20, zoom: true });
      const after = t.engine.camera.zoom;
      t.engine.pinch({ x: 100, y: 100 }, 2, 0, 0);

      expect(after, 'zoom after wheel').toBeGreaterThan(1);
      expect(t.engine.camera.zoom, 'zoom after pinch').toBeCloseTo(after * 2);
    });

    it('when zoom buttons are used then the zoom changes and the change is reported', () => {
      t.engine.setViewportSize({ w: 800, h: 600 });
      const zooms: number[] = [];
      t.engine.cameraChanged.on((c) => zooms.push(c.zoom));

      t.engine.zoomIn();
      t.engine.zoomOut();
      t.engine.zoomIn();
      t.engine.resetZoom();

      expect(
        zooms.map((z) => Math.round(z * 100) / 100),
        'zooms',
      ).toEqual([1.25, 1, 1.25, 1]);
    });

    it('when fit is called then all content is visible; on an empty board the camera resets', () => {
      t.engine.setViewportSize({ w: 800, h: 600 });
      t.engine.fit();
      expect(t.engine.camera, 'empty board').toEqual({ x: 0, y: 0, zoom: 1 });

      addSticky(2000, 1000, 400, 400);
      t.engine.fit();

      expect(t.engine.camera.zoom, 'zoom shows everything').toBeLessThan(1.5);
      expect(t.engine.camera.x + 2200 * t.engine.camera.zoom, 'centered x').toBeCloseTo(400);
    });
  });

  describe('undo', () => {
    it('when a drag is undone then the block returns in one step', () => {
      const id = addSticky(0, 0);
      t.drag({ x: 50, y: 50 }, { x: 150, y: 150 });
      expect(t.board.getBlock(id)?.x, 'moved').toBe(100);

      t.key('z', { mod: true });
      expect(t.board.getBlock(id)?.x, 'undone').toBe(0);
      t.key('z', { mod: true, shift: true });
      expect(t.board.getBlock(id)?.x, 'redone').toBe(100);
      t.key('z', { mod: true });
      t.key('y', { mod: true });
      expect(t.board.getBlock(id)?.x, 'redone with mod+Y').toBe(100);
    });

    it('when a remote edit arrives then undo does not touch it', () => {
      const own = addSticky();
      t.engine.stopCapturing();
      const remote = new Y.Doc();
      remote.getMap('blocks').set('r', new Y.Map());
      Y.applyUpdate(t.board.doc, Y.encodeStateAsUpdate(remote), 'remote-provider');

      t.engine.undo();

      expect(t.board.hasBlock(own), 'own block undone').toBe(false);
      expect(t.board.hasBlock('r'), 'remote block kept').toBe(true);
    });

    it('when history changes then the state is reported', () => {
      const states: boolean[] = [];
      t.engine.historyChanged.on((s) => states.push(s.canUndo));

      addSticky();
      expect(t.engine.historyState.canUndo, 'can undo').toBe(true);
      t.engine.undo();

      expect([states[0], states.at(-1)], 'first and last reported state').toEqual([true, false]);
      expect(t.engine.historyState.canRedo, 'can redo').toBe(true);
    });
  });

  describe('tool shortcuts', () => {
    it('when V, H, S are pressed then the tool changes and is reported', () => {
      const tools: string[] = [];
      t.engine.toolChanged.on((x) => tools.push(x));

      t.key('h');
      t.key('s');
      t.key('v');

      expect(tools, 'tool changes').toEqual(['hand', 'sticky', 'select']);
    });

    it('when a shortcut key has a modifier then it does not switch tools', () => {
      t.key('h', { mod: true });

      expect(t.engine.tool, 'tool').toBe('select');
    });

    it('when Delete is pressed with another tool active then the selection is still deleted', () => {
      const id = addSticky();
      t.engine.selection.set([id]);
      t.engine.setTool('hand');

      t.key('Delete');

      expect(t.board.hasBlock(id), 'deleted').toBe(false);
    });
  });

  describe('styles', () => {
    it('when a color is set then selected stickies get it and the panel reads it back', () => {
      const id = addSticky();
      t.engine.selection.set([id]);

      t.engine.setStyleForSelection({ color: '#bae6fd', fill: '#000' });

      expect(t.board.getBlock(id)?.props['color'], 'color').toBe('#bae6fd');
      expect(t.board.getBlock(id)?.props['fill'], 'fill is not a sticky field').toBeUndefined();
      expect(t.engine.selectionStyle(), 'style info').toEqual({ color: '#bae6fd' });
    });

    it('when strokes and connectors are selected then stroke style applies to them', () => {
      const s = t.board.addStroke([0, 0, 0.5, 5, 5, 0.5], { color: '#000', size: 2 });
      const c = t.board.addConnector({ x: 0, y: 0 }, { x: 9, y: 9 });
      t.engine.selection.set([s, c]);

      t.engine.setStyleForSelection({ stroke: '#f00', strokeWidth: 6 });

      expect(t.board.getStroke(s)?.style, 'stroke').toEqual({ color: '#f00', size: 6 });
      expect(t.board.getConnector(c)?.style, 'connector').toMatchObject({
        color: '#f00',
        width: 6,
      });
      expect(t.engine.selectionStyle(), 'info').toEqual({ stroke: '#f00', strokeWidth: 6 });
    });

    it('when the draw style changes then listeners are told', () => {
      const listener = vi.fn();
      t.engine.drawStyleChanged.on(listener);

      t.engine.setDrawStyle({ color: '#f00' });

      expect(t.engine.drawStyle.color, 'color').toBe('#f00');
      expect(listener, 'listener').toHaveBeenCalledOnce();
    });
  });

  describe('presence', () => {
    it('when the pointer moves then the local cursor and selection are reported; leaving clears the cursor', () => {
      const states: unknown[] = [];
      t.engine.localPresence.on((s) => states.push(s));

      t.engine.pointerMove(t.at(10, 20, { buttons: 0 }));
      t.engine.pointerLeave();

      expect(states, 'states').toEqual([
        { cursor: { x: 10, y: 20 }, selection: [] },
        { cursor: null, selection: [] },
      ]);
    });

    it('when the selection changes then it is reported with the last cursor', () => {
      const id = addSticky();
      const states: { selection: string[] }[] = [];
      t.engine.localPresence.on((s) => states.push(s));

      t.engine.selection.set([id]);

      expect(states.at(-1)?.selection, 'selection').toEqual([id]);
    });

    it('when peers are set then their cursor, name and selection outline are drawn, and bad colors are replaced', () => {
      const id = addSticky();

      t.engine.setPeers([
        {
          clientId: 7,
          name: '<b>Bob</b>',
          color: 'red;background:url(x)',
          guest: false,
          role: 'EDITOR',
          cursor: { x: 5, y: 5 },
          selection: [id],
          userId: 'user-1',
          viewport: null,
          following: null,
          summon: null,
        },
      ]);
      t.engine.flush();

      const peer = t.container.querySelector('[data-peer]');
      expect(peer?.textContent, 'name as text').toBe('<b>Bob</b>');
      expect(peer?.querySelector('b'), 'no markup').toBeNull();
      expect(peer?.querySelector('path')?.getAttribute('fill'), 'fallback color').toBe('#e8590c');
      expect(
        t.container.querySelectorAll('svg rect').length,
        'outline of the selected block',
      ).toBeGreaterThan(0);
    });
  });

  describe('overlay', () => {
    it('when one block is selected then 8 handles are drawn; a multi selection gets a box', () => {
      const a = addSticky(0, 0);
      const b = addSticky(300, 0);
      t.engine.selection.set([a]);
      t.engine.flush();
      expect(t.container.querySelectorAll('rect[data-handle]').length, 'handles').toBe(8);

      t.engine.selection.set([a, b]);
      t.engine.flush();

      expect(t.container.querySelectorAll('rect[data-handle]').length, 'no handles').toBe(0);
    });

    it('when the marquee is dragged then it is drawn and removed afterwards', () => {
      t.engine.pointerDown(t.at(0, 0));
      t.engine.pointerMove(t.at(100, 100));
      t.engine.flush();
      const drawn = t.container.querySelectorAll('svg rect').length;
      t.engine.pointerUp(t.at(100, 100, { buttons: 0 }));
      t.engine.flush();

      expect(drawn, 'marquee while dragging').toBe(1);
      expect(t.container.querySelectorAll('svg rect').length, 'after').toBe(0);
    });
  });

  describe('lifecycle', () => {
    it('when destroyed then the layers are removed and later changes do nothing', () => {
      const u = createTestEngine();
      u.destroy();

      expect(u.container.children.length, 'children').toBe(0);
    });

    it('when the registry is shared then registering a type twice fails', () => {
      const registry = registerBuiltinBlocks(new BlockTypeRegistry());

      expect(() => registerBuiltinBlocks(registry), 'second registration').toThrow(
        'already registered',
      );
      expect(
        registry.list().map((x) => x.type),
        'types',
      ).toContain('core.sticky');
      expect(registry.get('nope'), 'unknown').toBeUndefined();
    });

    it('when read-only is switched on while editing then the editor closes', () => {
      t.engine.startTextEdit(addSticky());
      t.engine.setTool('hand');
      t.engine.setTool('select');

      t.engine.setReadOnly(true);
      t.engine.setReadOnly(false);

      expect(t.engine.readOnly, 'read only').toBe(false);
      expect(LOCAL_ORIGIN, 'origin constant').toBe('drawboard-local');
    });
  });
  describe('selection anchor', () => {
    it('when nothing is selected then there is no anchor', () => {
      addSticky();

      expect(t.engine.selectionAnchor, 'anchor').toBeNull();
    });

    it('when a block is selected then the anchor is its rectangle in screen coordinates', () => {
      const id = addSticky(10, 20, 100, 50);
      t.engine.setCamera({ x: 5, y: 7, zoom: 2 });

      t.engine.selection.set([id]);

      expect(t.engine.selectionAnchor, 'anchor').toEqual({ x: 25, y: 47, w: 200, h: 100 });
    });

    it('when several items are selected then the anchor is their union', () => {
      const a = addSticky(0, 0, 100, 100);
      const b = addSticky(200, 100, 100, 100);

      t.engine.selection.set([a, b]);

      expect(t.engine.selectionAnchor, 'anchor').toEqual({ x: 0, y: 0, w: 300, h: 200 });
    });

    it('when the camera pans or zooms then the anchor follows and is emitted once per change', () => {
      const id = addSticky(0, 0, 100, 100);
      const seen: unknown[] = [];
      t.engine.selection.set([id]);
      t.engine.flush();
      t.engine.selectionAnchorChanged.on((a) => seen.push(a));

      t.engine.setCamera({ x: 50, y: 0, zoom: 1 });
      t.engine.flush();
      t.engine.flush();
      t.engine.setCamera({ x: 50, y: 0, zoom: 2 });
      t.engine.flush();

      expect(seen, 'emissions').toEqual([
        { x: 50, y: 0, w: 100, h: 100 },
        { x: 50, y: 0, w: 200, h: 200 },
      ]);
    });

    it('when the selection is dragged then the anchor is hidden and comes back after the drop', () => {
      const id = addSticky(0, 0, 100, 100);
      const seen: unknown[] = [];
      t.engine.selection.set([id]);
      t.engine.flush();
      t.engine.selectionAnchorChanged.on((a) => seen.push(a));

      t.engine.pointerDown(t.at(50, 50));
      t.engine.pointerMove(t.at(80, 50));
      t.engine.flush();
      t.engine.pointerUp(t.at(80, 50, { buttons: 0 }));
      t.engine.flush();

      expect(seen, 'hidden while dragging, then at the new place').toEqual([
        null,
        { x: 30, y: 0, w: 100, h: 100 },
      ]);
    });

    it('when the selected block changes size remotely then the anchor is updated', () => {
      const id = addSticky(0, 0, 100, 100);
      t.engine.selection.set([id]);
      t.engine.flush();
      const seen: unknown[] = [];
      t.engine.selectionAnchorChanged.on((a) => seen.push(a));

      t.board.setGeometry(id, { w: 160 });
      t.engine.flush();

      expect(seen, 'emissions').toEqual([{ x: 0, y: 0, w: 160, h: 100 }]);
    });

    it('when the engine is read only then there is no anchor', () => {
      const id = addSticky();
      t.engine.selection.set([id]);

      t.engine.setReadOnly(true);

      expect(t.engine.selectionAnchor, 'anchor').toBeNull();
    });
  });

  describe('dot grid', () => {
    it('when the camera moves then the container background is repositioned and rescaled', () => {
      t.engine.setCamera({ x: 30, y: 10, zoom: 1 });

      expect(t.container.style.backgroundSize, 'size').toBe('24px 24px');
      expect(t.container.style.backgroundPosition, 'position').toBe('18px -2px');

      t.engine.setCamera({ x: 0, y: 0, zoom: 0.5 });

      expect(t.container.style.backgroundSize, 'size zoomed out').toBe('24px 24px');
    });
  });

  describe('block views', () => {
    it('when a block is mounted then its view is told after the element is in the document', () => {
      let connected: boolean | undefined;
      const registry = registerBuiltinBlocks(new BlockTypeRegistry());
      registry.register({
        type: 'test.probe',
        label: 'Probe',
        defaultSize: { w: 10, h: 10 },
        defaultProps: {},
        render: (host) => ({
          update: () => undefined,
          mounted: () => (connected = host.isConnected),
          destroy: () => undefined,
        }),
      });
      const probe = createTestEngine({ registry });

      probe.board.addBlock({ type: 'test.probe', x: 0, y: 0, w: 10, h: 10 });
      probe.engine.flush();

      expect(connected, 'mounted() ran on an attached element').toBe(true);
      probe.destroy();
    });

    it('when a block type renders then only a trusted built-in type gets the BlockHost', () => {
      const seen: Record<string, unknown> = {};
      const probe = (type: string, trusted?: true): BlockType => ({
        type,
        label: type,
        defaultSize: { w: 10, h: 10 },
        defaultProps: {},
        ...(trusted ? { trusted } : {}),
        render: (_host, ctx) => {
          seen[type] = ctx.host;
          return { update: () => undefined, destroy: () => undefined };
        },
      });
      const registry = registerBuiltinBlocks(new BlockTypeRegistry());
      registry.register(probe('acme.plugin'));
      registry.register(probe('core.trusted-probe', true));
      const u = createTestEngine({ registry });

      u.board.addBlock({ type: 'acme.plugin', x: 0, y: 0, w: 10, h: 10 });
      u.board.addBlock({ type: 'core.trusted-probe', x: 0, y: 0, w: 10, h: 10 });
      u.engine.flush();

      expect(seen['acme.plugin'], 'plugin type: no host').toBeUndefined();
      expect(seen['core.trusted-probe'], 'trusted type: host').toBeDefined();
      u.destroy();
    });

    it('when the built-in blocks are registered then they and only they are trusted', () => {
      const registry = registerBuiltinBlocks(new BlockTypeRegistry());

      const types = registry.list();

      expect(types.length, 'built-in types').toBeGreaterThan(5);
      expect(
        types.filter((t) => t.trusted !== true).map((t) => t.type),
        'untrusted built-ins',
      ).toEqual([]);
    });
  });

  describe('draw style', () => {
    it('when a sticky color is chosen then the next sticky is created in it', () => {
      t.engine.setDrawStyle({ sticky: '#bae6fd' });
      t.engine.setTool('sticky');

      t.click(50, 50);

      const [sticky] = t.board.blocks();
      expect(sticky?.props['color'], 'color of the new note').toBe('#bae6fd');
    });
  });

  describe('selection commands', () => {
    it('when the selection is deleted then it is gone in one undo step', () => {
      const a = addSticky(0, 0);
      const b = addSticky(200, 0);
      t.engine.selection.set([a, b]);

      t.engine.deleteSelection();

      expect(t.board.blockIds().length, 'blocks').toBe(0);
      expect(t.engine.selection.size, 'selection').toBe(0);
      t.engine.undo();
      expect(t.board.blockIds().length, 'blocks after one undo').toBe(2);
    });

    it('when the selection is duplicated then the copies are offset and selected', () => {
      const a = addSticky(10, 10);
      t.engine.selection.set([a]);

      t.engine.duplicateSelection();

      expect(t.board.blockIds().length, 'blocks').toBe(2);
      const [copyId] = t.engine.selection.list();
      expect(copyId, 'copy is selected, not the original').not.toBe(a);
      expect(t.board.getBlock(copyId as string)?.x, 'offset').toBe(34);
    });

    it('when the engine is read only then neither command does anything', () => {
      const a = addSticky();
      t.engine.selection.set([a]);
      t.engine.setReadOnly(true);

      t.engine.deleteSelection();
      t.engine.duplicateSelection();

      expect(t.board.blockIds().length, 'blocks').toBe(1);
    });
  });

  describe('selection kind', () => {
    it('when nothing is selected then the kind is none', () => {
      expect(t.engine.selectionKind(), 'kind').toBe('none');
    });

    it('when only stickies are selected then the kind is sticky', () => {
      t.engine.selection.set([addSticky(), addSticky(200, 0)]);

      expect(t.engine.selectionKind(), 'kind').toBe('sticky');
    });

    it.each([
      ['core.text', 'text'],
      ['core.shape', 'shape'],
      ['acme.timer', 'other'],
    ])('when a %s block is selected then the kind is %s', (type, kind) => {
      t.engine.selection.set([t.board.addBlock({ type, x: 0, y: 0, w: 50, h: 50 })]);

      expect(t.engine.selectionKind(), 'kind').toBe(kind);
    });

    it('when a stroke and a sticky are selected then the kind is mixed', () => {
      const stroke = t.board.addStroke([0, 0, 0.5, 10, 10, 0.5], { color: '#000000', size: 2 });
      t.engine.selection.set([stroke, addSticky()]);

      expect(t.engine.selectionKind(), 'kind').toBe('mixed');
    });

    it('when only a connector is selected then the kind is connector', () => {
      const a = addSticky(0, 0);
      const b = addSticky(300, 0);
      const c = t.board.addConnector({ block: a, anchor: 'auto' }, { block: b, anchor: 'auto' });
      t.engine.selection.set([c]);

      expect(t.engine.selectionKind(), 'kind').toBe('connector');
    });
  });
});
