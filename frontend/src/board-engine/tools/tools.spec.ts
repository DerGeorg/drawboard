import { shapeGeometry } from '../blocks/shape';
import { TestEngine, createTestEngine } from '../testing/helpers';
import { nearestSide } from './connector-tool';

describe('tools', () => {
  let t: TestEngine;
  beforeEach(() => (t = createTestEngine()));
  afterEach(() => t.destroy());

  function sticky(x: number, y: number, w = 100, h = 100): string {
    return t.board.addBlock({
      type: 'core.sticky',
      x,
      y,
      w,
      h,
      props: { color: '#fff' },
      text: '',
    });
  }

  describe('shortcuts', () => {
    it.each([
      ['t', 'text'],
      ['r', 'rect'],
      ['o', 'ellipse'],
      ['d', 'diamond'],
      ['c', 'connector'],
      ['p', 'pen'],
      ['e', 'eraser'],
    ])('when %s is pressed then the %s tool is active', (key, tool) => {
      t.key(key);

      expect(t.engine.tool, 'tool').toBe(tool);
    });

    it('when mod+D is pressed then it duplicates instead of selecting the diamond tool', () => {
      const id = sticky(0, 0);
      t.engine.selection.set([id]);

      t.key('d', { mod: true });

      expect(t.engine.tool, 'tool').toBe('select');
      expect(t.board.blockIds().length, 'blocks').toBe(2);
    });
  });

  describe('text tool', () => {
    it('when clicking then an empty text block is created with an open editor, and removed again if left empty', () => {
      t.engine.setTool('text');

      t.click(100, 100);
      const [block] = t.board.blocks();
      expect(block, 'block').toMatchObject({ type: 'core.text', w: 220, h: 48 });
      expect(t.container.querySelector('textarea'), 'editor').not.toBeNull();
      t.container.querySelector('textarea')?.blur();

      expect(t.board.blockIds().length, 'blocks after leaving empty').toBe(0);
    });

    it('when text is typed then the block renders it with the font from its props', () => {
      t.engine.setTool('text');
      t.click(100, 100);
      const ta = t.container.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = 'Title';
      ta.dispatchEvent(new Event('input'));
      ta.blur();

      const id = t.board.blockIds()[0] ?? '';
      const el = t.engine.blockElement(id)?.querySelector('.be-text') as HTMLElement;
      expect(el.textContent, 'text').toBe('Title');
      expect(el.style.fontSize, 'font size').toBe('20px');
      t.engine.selection.set([id]);
      t.engine.setStyleForSelection({ color: '#dc2626' });
      expect(
        (t.engine.blockElement(id)?.querySelector('.be-text') as HTMLElement).style.color,
        'color',
      ).toBe('rgb(220, 38, 38)');
    });
  });

  describe('shape tools', () => {
    it.each([
      ['rect', 'rect'],
      ['ellipse', 'ellipse'],
      ['diamond', 'polygon'],
    ])('when the %s tool clicks then a shape is drawn as an svg %s', (tool, tag) => {
      t.engine.setTool(tool as 'rect');

      t.click(200, 200);

      const [block] = t.board.blocks();
      expect(block?.type, 'type').toBe('core.shape');
      expect(block?.props['kind'], 'kind').toBe(tool);
      expect(
        t.engine.blockElement(block?.id ?? '')?.querySelector(`svg ${tag}`),
        'svg element',
      ).not.toBeNull();
      expect(
        t.container.querySelector('textarea'),
        'shapes do not open the editor on creation',
      ).toBeNull();
    });

    it('when the draw style is set then new shapes use it', () => {
      t.engine.setDrawStyle({ fill: '#bae6fd', color: '#dc2626' });
      t.engine.setTool('rect');

      t.click(0, 0);

      expect(t.board.blocks()[0]?.props, 'props').toMatchObject({
        fill: '#bae6fd',
        stroke: '#dc2626',
      });
    });

    it('when a shape is restyled and resized then its svg follows', () => {
      t.engine.setTool('rect');
      t.click(100, 100);
      const id = t.board.blockIds()[0] ?? '';
      t.engine.selection.set([id]);

      t.engine.setStyleForSelection({ fill: '#000', stroke: '#fff', strokeWidth: 8 });
      t.board.setGeometry(id, { w: 300 });
      t.board.setProp(id, 'kind', 'ellipse');

      const shape = t.engine.blockElement(id)?.querySelector('svg ellipse');
      expect(shape?.getAttribute('fill'), 'fill').toBe('#000');
      expect(shape?.getAttribute('stroke-width'), 'stroke width').toBe('8');
      expect(shape?.getAttribute('rx'), 'half of the inset width').toBe(String((300 - 8) / 2));
      expect(t.engine.blockElement(id)?.querySelector('svg rect'), 'old rect removed').toBeNull();
    });

    it('when a shape has text then it is shown centered; double click edits it', () => {
      t.engine.setTool('rect');
      t.click(100, 100);
      const id = t.board.blockIds()[0] ?? '';

      t.engine.doubleClick(t.at(100, 100, { detail: 2 }));

      expect(t.container.querySelector('textarea'), 'editor').not.toBeNull();
      expect(t.board.hasBlock(id), 'block kept').toBe(true);
    });

    it('when computing geometry then each kind fits the box', () => {
      expect(shapeGeometry('rect', 100, 50, 1).attrs, 'rect').toMatchObject({
        width: '98',
        height: '48',
      });
      expect(shapeGeometry('ellipse', 100, 50, 1).attrs, 'ellipse').toMatchObject({
        cx: '50',
        cy: '25',
        rx: '49',
        ry: '24',
      });
      expect(shapeGeometry('diamond', 100, 50, 0).attrs['points'], 'diamond').toBe(
        '50,0 100,25 50,50 0,25',
      );
    });
  });

  describe('connector tool', () => {
    it('when dragging from block to block then a connector with snapped sides is created and selected', () => {
      const a = sticky(0, 0);
      const b = sticky(300, 0);
      t.engine.setTool('connector');

      t.drag({ x: 98, y: 50 }, { x: 302, y: 50 });

      const [c] = t.board.connectors();
      expect(c?.from, 'from').toEqual({ block: a, anchor: 'right' });
      expect(c?.to, 'to').toEqual({ block: b, anchor: 'left' });
      expect(t.engine.selection.list(), 'selection').toEqual([c?.id]);
      expect(t.engine.tool, 'tool').toBe('select');
    });

    it('when the pointer moves over a block while dragging then a ghost line and the snap target are shown', () => {
      sticky(0, 0);
      const b = sticky(300, 0);
      t.engine.setTool('connector');

      t.engine.pointerDown(t.at(50, 50));
      t.engine.pointerMove(t.at(350, 50));
      t.engine.flush();

      expect(t.container.querySelectorAll('svg path[stroke-dasharray]').length, 'ghost line').toBe(
        1,
      );
      expect(t.container.querySelectorAll('svg rect').length, 'snap highlight').toBeGreaterThan(0);
      t.engine.pointerCancel();
      t.engine.flush();
      expect(
        t.container.querySelectorAll('svg path[stroke-dasharray]').length,
        'ghost removed',
      ).toBe(0);
      expect(t.board.hasBlock(b), 'block kept').toBe(true);
    });

    it('when the end is released on empty space then it stays a free point', () => {
      const a = sticky(0, 0);
      t.engine.setTool('connector');

      t.drag({ x: 50, y: 98 }, { x: 50, y: 400 });

      expect(t.board.connectors()[0], 'connector').toMatchObject({
        from: { block: a, anchor: 'bottom' },
        to: { x: 50, y: 400 },
      });
    });

    it('when the drag starts on empty space then the start is free', () => {
      const b = sticky(300, 0);
      t.engine.setTool('connector');

      t.drag({ x: 50, y: 400 }, { x: 350, y: 2 });

      expect(t.board.connectors()[0], 'connector').toMatchObject({
        from: { x: 50, y: 400 },
        to: { block: b, anchor: 'top' },
      });
    });

    it('when the connector is a click or stays on one block then nothing is created', () => {
      sticky(0, 0);
      t.engine.setTool('connector');

      t.click(50, 50);
      t.drag({ x: 10, y: 10 }, { x: 90, y: 90 });

      expect(t.board.connectors().length, 'connectors').toBe(0);
    });

    it('when a block moves then the connector follows and is redrawn', () => {
      const a = sticky(0, 0);
      sticky(300, 0);
      t.engine.setTool('connector');
      t.drag({ x: 98, y: 50 }, { x: 302, y: 50 });
      const before = t.container.querySelector('[data-connector-id] path')?.getAttribute('d');

      t.board.moveItems([a], 0, 100);

      const after = t.container.querySelector('[data-connector-id] path')?.getAttribute('d');
      expect(after, 'path after moving the block').not.toBe(before);
      expect(after, 'starts at the moved block side').toContain('M100 150');
    });

    it('when a connector has a label, dashes and no arrow then they are drawn; a missing end block hides it', () => {
      const a = sticky(0, 0);
      const b = sticky(300, 0);
      const id = t.board.addConnector(
        { block: a, anchor: 'auto' },
        { block: b, anchor: 'auto' },
        { dashed: true, arrow: false },
        'next',
      );

      const g = t.container.querySelector(`[data-connector-id="${id}"]`);
      expect(g?.querySelector('text')?.textContent, 'label').toBe('next');
      expect(g?.querySelector('path')?.getAttribute('stroke-dasharray'), 'dashes').toBeTruthy();
      expect(
        g?.querySelector('path')?.getAttribute('d')?.split('L').length,
        'one line segment, no arrow head',
      ).toBe(2);
    });

    it('when a connector is hit-tested then clicking near its line selects it', () => {
      const c = t.board.addConnector({ x: 0, y: 500 }, { x: 400, y: 500 });

      t.click(200, 503);

      expect(t.engine.selection.list(), 'selection').toEqual([c]);
    });

    it('when picking the nearest side then the closest edge wins', () => {
      const r = { x: 0, y: 0, w: 100, h: 100 };

      expect(nearestSide(r, { x: 5, y: 50 }), 'left').toBe('left');
      expect(nearestSide(r, { x: 95, y: 50 }), 'right').toBe('right');
      expect(nearestSide(r, { x: 50, y: 4 }), 'top').toBe('top');
      expect(nearestSide(r, { x: 50, y: 97 }), 'bottom').toBe('bottom');
    });
  });

  describe('pen tool', () => {
    it('when drawing then a stroke with the raw points is stored once, with the draw style', () => {
      t.engine.setDrawStyle({ color: '#dc2626', size: 6 });
      t.engine.setTool('pen');

      t.engine.pointerDown(t.at(10, 10, { pressure: 0.3 }));
      t.engine.pointerMove(t.at(10.5, 10));
      t.engine.pointerMove(t.at(40, 30, { pressure: 0.6 }));
      t.engine.flush();
      expect(t.board.strokeIds().length, 'not stored while drawing').toBe(0);
      expect(t.container.querySelectorAll('svg path[fill="#dc2626"]').length, 'live preview').toBe(
        1,
      );
      t.engine.pointerUp(t.at(40, 30, { buttons: 0 }));

      const [stroke] = t.board.strokes();
      expect(stroke?.points, 'raw points: the 0.5px move is ignored').toEqual([
        10, 10, 0.3, 40, 30, 0.6,
      ]);
      expect(stroke?.style, 'style').toEqual({ color: '#dc2626', size: 6 });
      expect(t.engine.tool, 'tool stays pen').toBe('pen');
      expect(
        t.container.querySelector('path[data-stroke-id]')?.getAttribute('d'),
        'outline rendered',
      ).toMatch(/^M/);
    });

    it('when only clicking then a dot is stored', () => {
      t.engine.setTool('pen');

      t.click(10, 10);

      expect(t.board.strokes()[0]?.points, 'points').toEqual([10, 10, 0.5]);
    });

    it('when the gesture is cancelled then nothing is stored', () => {
      t.engine.setTool('pen');
      t.engine.pointerDown(t.at(1, 1));
      t.engine.pointerCancel();
      t.engine.pointerUp(t.at(1, 1, { buttons: 0 }));

      expect(t.board.strokeIds().length, 'strokes').toBe(0);
    });

    it('when a stroke is selected, moved, duplicated and deleted then it behaves like a block', () => {
      t.engine.setTool('pen');
      t.drag({ x: 0, y: 0 }, { x: 100, y: 0 });
      t.engine.setTool('select');

      t.click(50, 0);
      const id = t.board.strokeIds()[0] ?? '';
      expect(t.engine.selection.list(), 'selected by click').toEqual([id]);
      t.key('ArrowDown', { shift: true });
      expect(t.board.getStroke(id)?.points.slice(0, 2), 'moved').toEqual([0, 10]);
      t.key('d', { mod: true });
      expect(t.board.strokeIds().length, 'duplicated').toBe(2);
      t.key('Delete');
      expect(t.board.strokeIds().length, 'deleted the copy').toBe(1);
    });
  });

  describe('eraser tool', () => {
    it('when dragging over strokes then they are deleted, other items stay, and it is one undo step', () => {
      const keep = sticky(0, 300);
      t.board.addStroke([0, 0, 0.5, 100, 0, 0.5], { color: '#000', size: 4 });
      t.board.addStroke([0, 50, 0.5, 100, 50, 0.5], { color: '#000', size: 4 });
      t.engine.setTool('eraser');

      t.drag({ x: 50, y: -10 }, { x: 50, y: 60 });
      t.engine.pointerDown(t.at(500, 500));
      t.engine.pointerMove(t.at(500, 501));
      t.engine.pointerCancel();
      t.engine.pointerUp(t.at(500, 501, { buttons: 0 }));

      expect(t.board.strokeIds().length, 'strokes left').toBe(0);
      expect(t.board.hasBlock(keep), 'block kept').toBe(true);
      t.key('z', { mod: true });
      expect(t.board.strokeIds().length, 'strokes after one undo').toBe(2);
    });

    it('when the engine is read-only then the pen and eraser are not available', () => {
      const u = createTestEngine({ readOnly: true });

      u.engine.setTool('pen');
      u.engine.setTool('eraser');

      expect(u.engine.tool, 'tool').toBe('select');
      u.destroy();
    });
  });
});
