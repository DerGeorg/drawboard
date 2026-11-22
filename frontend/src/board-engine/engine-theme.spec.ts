import { BlockData, BoardTheme } from '@apps/drawboard-engine';
import { SIMPLE_ZOOM } from './renderer/simple-view';
import { TestEngine, createTestEngine } from './testing/helpers';

describe('BoardEngine theme', () => {
  let t: TestEngine;
  beforeEach(() => (t = createTestEngine()));
  afterEach(() => t.destroy());

  const shape = (props: Record<string, unknown> = {}): string =>
    t.board.addBlock({
      type: 'core.shape',
      x: 0,
      y: 0,
      w: 120,
      h: 80,
      props: { kind: 'rect', fill: '#ffffff', stroke: '#0f172a', ...props },
    });
  const frame = (fill = '#ffffff'): string =>
    t.board.addBlock({
      type: 'core.frame',
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      props: { fill },
      text: 'F',
    });
  const text = (color = '#0f172a'): string =>
    t.board.addBlock({
      type: 'core.text',
      x: 0,
      y: 0,
      w: 100,
      h: 40,
      props: { color, fontSize: 20 },
      text: 'Hello',
    });
  const el = (id: string): HTMLElement => t.engine.blockElement(id) as HTMLElement;
  const outline = (id: string): SVGElement => el(id).querySelector('svg [fill]') as SVGElement;
  const snapshot = (): string =>
    JSON.stringify(t.board.blocks().map((b: BlockData) => [b.id, b.props, b.x, b.y, b.w, b.h]));

  describe('setTheme', () => {
    it('when the engine starts then it is light with the light chrome variables', () => {
      expect(t.engine.theme, 'theme').toBe('light');
      expect(t.container.dataset['beTheme'], 'data attribute').toBe('light');
      expect(t.container.style.getPropertyValue('--be-grid-dot'), 'grid dot').toContain(
        '15, 23, 42',
      );
    });

    it('when the theme is dark then the grid dots are light and the selection is brighter', () => {
      t.engine.setTheme('dark');

      expect(t.container.dataset['beTheme'], 'data attribute').toBe('dark');
      expect(t.container.style.getPropertyValue('--be-grid-dot'), 'grid dot').toContain(
        '226, 232, 240',
      );
      expect(t.container.style.getPropertyValue('--be-selection'), 'selection').toBe('#60a5fa');
    });

    it('when the engine is created dark then the first render is already dark', () => {
      t.destroy();
      t = createTestEngine({ theme: 'dark' });
      const id = shape();

      expect(outline(id).getAttribute('fill'), 'fill').toBe('#1e293b');
    });

    it('when the same theme is set again then nothing renders and nothing is emitted', () => {
      const emitted: BoardTheme[] = [];
      t.engine.themeChanged.on((theme) => emitted.push(theme));

      t.engine.setTheme('light');

      expect(emitted, 'emitted').toEqual([]);
    });

    it('when the theme changes then themeChanged tells the new one', () => {
      const emitted: BoardTheme[] = [];
      t.engine.themeChanged.on((theme) => emitted.push(theme));

      t.engine.setTheme('dark');
      t.engine.setTheme('light');

      expect(emitted, 'emitted').toEqual(['dark', 'light']);
    });
  });

  describe('content colours', () => {
    it('when the theme is dark then the default ink and a white fill are shown mapped', () => {
      const id = shape();
      const label = text();

      t.engine.setTheme('dark');

      expect(outline(id).getAttribute('fill'), 'shape fill').toBe('#1e293b');
      expect(outline(id).getAttribute('stroke'), 'shape stroke').toBe('#e2e8f0');
      expect(el(label).querySelector<HTMLElement>('.be-text')?.style.color, 'text ink').toBe(
        'rgb(226, 232, 240)',
      );
    });

    it('when the theme is dark then pastel fills and their dark text stay', () => {
      const id = shape({ fill: '#fde68a', stroke: '#2563eb' });

      t.engine.setTheme('dark');

      expect(outline(id).getAttribute('fill'), 'fill').toBe('#fde68a');
      expect(outline(id).getAttribute('stroke'), 'stroke').toBe('#2563eb');
      expect(el(id).querySelector<HTMLElement>('.be-text')?.style.color, 'text').toBe(
        'rgb(31, 41, 55)',
      );
    });

    it('when the theme is dark then text on a themed fill follows the theme variable', () => {
      const id = shape();

      t.engine.setTheme('dark');

      expect(el(id).querySelector<HTMLElement>('.be-text')?.style.color, 'text').toBe(
        'var(--be-text, #1f2937)',
      );
    });

    it('when the theme is dark then a frame draws its white fill dark and keeps a pastel one', () => {
      const white = frame();
      const pastel = frame('#bbf7d0');

      t.engine.setTheme('dark');

      expect(el(white).querySelector<HTMLElement>('.be-frame')?.style.background, 'white').toBe(
        'rgb(30, 41, 59)',
      );
      expect(el(pastel).querySelector<HTMLElement>('.be-frame')?.style.background, 'pastel').toBe(
        'rgb(187, 247, 208)',
      );
      expect(
        el(pastel).querySelector<HTMLElement>('.be-frame-title')?.style.color,
        'title on pastel stays dark',
      ).toBe('rgb(71, 85, 105)');
    });

    it('when the theme is dark then connectors and pen strokes are drawn with the mapped ink', () => {
      const stroke = t.board.addStroke([0, 0, 0.5, 5, 5, 0.5], { color: '#0f172a', size: 2 });
      const connector = t.board.addConnector({ x: 0, y: 0 }, { x: 90, y: 90 });
      t.engine.flush();

      t.engine.setTheme('dark');

      const path = t.container.querySelector(`[data-stroke-id="${stroke}"]`);
      const line = t.container.querySelector(`[data-connector-id="${connector}"] path`);
      expect(path?.getAttribute('fill'), 'stroke fill').toBe('#e2e8f0');
      expect(line?.getAttribute('stroke'), 'connector stroke').toBe('#cbd5e1');

      t.engine.setTheme('light');
      expect(path?.isConnected, 'redrawn, the old element is gone').toBe(false);
      expect(
        t.container.querySelector(`[data-stroke-id="${stroke}"]`)?.getAttribute('fill'),
        'light again',
      ).toBe('#0f172a');
    });

    it('when the theme goes back to light then every colour is the stored one again', () => {
      const id = shape();

      t.engine.setTheme('dark');
      t.engine.setTheme('light');

      expect(outline(id).getAttribute('fill'), 'fill').toBe('#ffffff');
      expect(outline(id).getAttribute('stroke'), 'stroke').toBe('#0f172a');
    });
  });

  describe('far zoomed out', () => {
    it('when the theme is dark then the simple boxes use the mapped colours', () => {
      const white = shape();
      const pastel = shape({ fill: '#fde68a' });
      const file = t.board.addBlock({ type: 'core.file', x: 0, y: 0, w: 50, h: 50 });
      t.engine.setCamera({ x: 0, y: 0, zoom: SIMPLE_ZOOM - 0.05 });
      t.engine.flush();
      const box = (id: string): HTMLElement => el(id).querySelector('.be-simple') as HTMLElement;

      t.engine.setTheme('dark');

      expect(box(white).style.background, 'white fill').toBe('rgb(30, 41, 59)');
      expect(box(pastel).style.background, 'pastel').toBe('rgb(253, 230, 138)');
      expect(box(file).style.background, 'neutral box').toBe('rgb(51, 65, 85)');
    });
  });

  describe('the document', () => {
    it('when the theme changes then no block, colour or undo step is written', () => {
      shape();
      frame();
      text();
      t.engine.flush();
      const before = snapshot();
      const changes: unknown[] = [];
      t.board.observe((change) => changes.push(change));
      const undoable = t.engine.historyState.canUndo;

      t.engine.setTheme('dark');
      t.engine.setTheme('light');

      expect(changes, 'document changes').toEqual([]);
      expect(snapshot(), 'blocks and colours').toBe(before);
      expect(t.engine.historyState.canUndo, 'undo steps').toBe(undoable);
    });

    it('when a theme was set then new content is still stored with the plain default colours', () => {
      t.engine.setTheme('dark');

      const id = shape();

      expect(t.board.getBlock(id)?.props['fill'], 'stored fill').toBe('#ffffff');
      expect(t.board.getBlock(id)?.props['stroke'], 'stored stroke').toBe('#0f172a');
    });
  });
});
