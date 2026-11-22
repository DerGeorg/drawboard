import { registerBuiltinBlocks } from './blocks/builtin';
import { MIN_ZOOM } from '@apps/drawboard-engine';
import { BlockTypeRegistry } from './renderer/block-registry';
import { FULL_ZOOM, SIMPLE_NEUTRAL, SIMPLE_ZOOM } from './renderer/simple-view';
import { TestEngine, createTestEngine } from './testing/helpers';

/**
 * Far zoomed out (down to 2 %): plain boxes instead of block views, culling over a huge area,
 * the zoom shortcuts. jsdom has no layout, so "fast" is checked by what the engine does - how
 * many elements it creates and whether a pan remounts anything - never by wall-clock time.
 */
describe('BoardEngine far zoomed out', () => {
  let t: TestEngine;
  let renders: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    renders = vi.fn<() => void>();
    const registry = registerBuiltinBlocks(new BlockTypeRegistry());
    // stands in for every expensive view: plugin frames, images, PDFs, Mermaid
    registry.register({
      type: 'acme.heavy',
      label: 'Heavy',
      defaultSize: { w: 100, h: 100 },
      defaultProps: {},
      render(host) {
        renders();
        const frame = host.ownerDocument.createElement('iframe');
        host.appendChild(frame);
        return { update: () => undefined, destroy: () => frame.remove() };
      },
    });
    t = createTestEngine({ registry });
  });
  afterEach(() => t.destroy());

  const sticky = (x: number, y: number, color = '#bae6fd'): string =>
    t.board.addBlock({ type: 'core.sticky', x, y, w: 200, h: 200, props: { color }, text: 'Hi' });
  const zoomTo = (zoom: number): void => {
    t.engine.setCamera({ x: 0, y: 0, zoom });
    t.engine.flush();
  };

  describe('level of detail', () => {
    it('when zoomed below SIMPLE_ZOOM then a sticky is one coloured box without text', () => {
      const id = sticky(0, 0);
      t.engine.flush();
      expect(
        t.engine.blockElement(id)?.querySelector('.be-text'),
        'full view first',
      ).not.toBeNull();

      zoomTo(SIMPLE_ZOOM - 0.01);

      const el = t.engine.blockElement(id);
      expect(t.engine.simplified, 'simplified').toBe(true);
      expect(el?.dataset['lod'], 'level of detail').toBe('simple');
      expect(el?.querySelector('.be-text'), 'no text').toBeNull();
      expect(el?.childElementCount, 'one box').toBe(1);
      expect((el?.firstElementChild as HTMLElement).style.background, 'sticky colour').toBe(
        'rgb(186, 230, 253)',
      );
    });

    it('when zoomed out then expensive views (plugins, files, diagrams) are not rendered at all', () => {
      zoomTo(MIN_ZOOM);
      const id = t.board.addBlock({ type: 'acme.heavy', x: 0, y: 0, w: 100, h: 100 });
      t.engine.flush();

      expect(renders, 'never rendered').not.toHaveBeenCalled();
      expect(t.container.querySelector('iframe'), 'no frame').toBeNull();
      expect(
        (t.engine.blockElement(id)?.firstElementChild as HTMLElement).style.background,
        'neutral box',
      ).toBe('rgb(226, 232, 240)');
      expect(SIMPLE_NEUTRAL, 'neutral').toBe('#e2e8f0');
    });

    it('when an expensive view is on screen and the user zooms out then it is destroyed', () => {
      t.board.addBlock({ type: 'acme.heavy', x: 0, y: 0, w: 100, h: 100 });
      t.engine.flush();
      expect(t.container.querySelector('iframe'), 'frame at 100 %').not.toBeNull();

      zoomTo(0.05);

      expect(t.container.querySelector('iframe'), 'frame gone').toBeNull();
    });

    it('when a frame is simplified then it keeps its title at a fixed screen size', () => {
      const id = t.board.addBlock({
        type: 'core.frame',
        x: 0,
        y: 0,
        w: 800,
        h: 600,
        props: { fill: 'url(https://evil.example/x.png)' },
        text: 'Sprint 12',
      });
      zoomTo(0.05);

      const el = t.engine.blockElement(id);
      const title = el?.querySelector<HTMLElement>('.be-simple-title');
      expect(title?.textContent, 'title').toBe('Sprint 12');
      expect(title?.style.font, 'screen-sized font').toContain('--be-inv-zoom');
      expect(
        (el?.querySelector('.be-simple') as HTMLElement).style.background,
        'fill through safeColor (S5.2)',
      ).toBe('rgb(255, 255, 255)');
      expect(
        t.container
          .querySelector<HTMLElement>('.be-world')
          ?.style.getPropertyValue('--be-inv-zoom'),
        '1 / zoom',
      ).toBe('20');
    });

    it('when the title of a simplified frame changes then the box follows', () => {
      const id = t.board.addBlock({ type: 'core.frame', x: 0, y: 0, w: 800, h: 600, text: 'A' });
      zoomTo(0.05);

      t.board.getText(id)?.insert(1, 'B');
      t.board.setProp(id, 'fill', '#fde68a');
      t.engine.flush();

      const el = t.engine.blockElement(id);
      expect(el?.querySelector('.be-simple-title')?.textContent, 'title').toBe('AB');
      expect((el?.querySelector('.be-simple') as HTMLElement).style.background, 'fill').toBe(
        'rgb(253, 230, 138)',
      );
    });

    it('when zooming back in then the full views return, with hysteresis around the threshold', () => {
      const id = sticky(0, 0);
      zoomTo(0.1);
      const mounts = t.engine.blockMountCount;

      zoomTo((SIMPLE_ZOOM + FULL_ZOOM) / 2);
      expect(t.engine.simplified, 'still simple between the thresholds').toBe(true);
      expect(t.engine.blockMountCount, 'no remount').toBe(mounts);

      zoomTo(FULL_ZOOM);
      expect(t.engine.simplified, 'full again').toBe(false);
      expect(t.engine.blockElement(id)?.querySelector('.be-text')?.textContent, 'text').toBe('Hi');

      zoomTo((SIMPLE_ZOOM + FULL_ZOOM) / 2);
      expect(t.engine.simplified, 'full between the thresholds').toBe(false);
    });

    it('when simplified then text editing does not start, and a running edit stops', () => {
      const id = sticky(0, 0);
      t.engine.flush();
      t.engine.startTextEdit(id);
      expect(t.container.querySelector('textarea'), 'editing').not.toBeNull();

      zoomTo(0.05);
      expect(t.container.querySelector('textarea'), 'stopped').toBeNull();

      t.engine.startTextEdit(id);
      expect(t.container.querySelector('textarea'), 'refused').toBeNull();
    });
  });

  describe('culling over a huge area', () => {
    it('when 400 blocks are spread far apart at 2 % then only those in view are mounted, once each', () => {
      // 1000 x 800 px at 2 % = 50 000 x 40 000 world units (+ 15 000 margin on each side)
      t.engine.setViewportSize({ w: 1000, h: 800 });
      zoomTo(MIN_ZOOM);
      // a 20 x 20 grid, 5 000 world units apart (100 000 x 100 000 in total)
      t.board.transact(() => {
        for (let i = 0; i < 400; i++) {
          t.board.addBlock({
            type: 'core.sticky',
            x: (i % 20) * 5000,
            y: Math.floor(i / 20) * 5000,
            w: 200,
            h: 200,
          });
        }
      });
      t.engine.flush();

      // x in [-15 000, 65 000] -> columns 0..13, y in [-15 000, 55 000] -> rows 0..11
      expect(t.engine.mountedBlockCount, 'in view').toBe(14 * 12);
      const blocks = t.container.querySelector('.be-blocks') as HTMLElement;
      expect(blocks.querySelectorAll('*').length, 'two elements per block').toBe(14 * 12 * 2);

      const mounts = t.engine.blockMountCount;
      t.engine.setCamera({ x: 3, y: -2, zoom: MIN_ZOOM });
      t.engine.flush();
      expect(t.engine.blockMountCount, 'a small pan remounts nothing').toBe(mounts);

      t.engine.setCamera({ x: -1400, y: 0, zoom: MIN_ZOOM }); // 70 000 world units to the right
      t.engine.flush();
      // x in [55 000, 135 000] -> columns 11..19
      expect(t.engine.mountedBlockCount, 'scrolled').toBe(9 * 12);
    });
  });

  describe('zoom limits and shortcuts', () => {
    it('when zooming out with the button then it stops at 2 %', () => {
      for (let i = 0; i < 40; i++) {
        t.engine.zoomOut();
      }

      expect(t.engine.camera.zoom, 'min').toBe(0.02);
    });

    it('when a huge board is fitted then the zoom goes below 10 %', () => {
      t.engine.setViewportSize({ w: 1000, h: 800 });
      sticky(0, 0);
      sticky(40_000, 30_000);

      t.engine.fit();

      expect(t.engine.camera.zoom, 'zoom').toBeLessThan(0.03);
      expect(t.engine.camera.zoom, 'zoom').toBeGreaterThanOrEqual(MIN_ZOOM);
    });

    it('when mod plus and mod minus are pressed then the camera zooms in and out', () => {
      expect(t.key('+', { mod: true }), 'handled').toBe(true);
      expect(t.engine.camera.zoom, 'in').toBeCloseTo(1.25);
      t.key('=', { mod: true });
      t.key('-', { mod: true });
      t.key('-', { mod: true });
      expect(t.engine.camera.zoom, 'out').toBeCloseTo(1);
    });

    it('when Shift+1 is pressed then the board is fitted, Shift+0 goes back to 100 %', () => {
      t.engine.setViewportSize({ w: 1000, h: 800 });
      sticky(0, 0);
      sticky(20_000, 0);

      // Shift+1 is '!' on most layouts; the physical key decides
      expect(
        t.engine.keyDown({
          key: '!',
          code: 'Digit1',
          shift: true,
          alt: false,
          mod: false,
          repeat: false,
        }),
        'fit handled',
      ).toBe(true);
      expect(t.engine.camera.zoom, 'fitted').toBeLessThan(0.1);

      t.engine.keyDown({
        key: '=',
        code: 'Digit0',
        shift: true,
        alt: false,
        mod: false,
        repeat: false,
      });
      expect(t.engine.camera.zoom, '100 %').toBe(1);
    });

    it('when mod+0 is pressed then the zoom is 100 %; a plain 1 or 0 is not a shortcut', () => {
      t.engine.setCamera({ x: 0, y: 0, zoom: 0.3 });

      expect(t.key('1'), 'plain 1').toBe(false);
      expect(t.key('0', { mod: true }), 'mod+0').toBe(true);
      expect(t.engine.camera.zoom, '100 %').toBe(1);
    });
  });
});
