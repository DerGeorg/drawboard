import {
  applyGrid,
  GRID_FADE_FROM,
  GRID_HIDDEN_BELOW,
  GRID_SPACING,
  gridAlpha,
  gridStyle,
} from './grid';

describe('grid', () => {
  describe('gridStyle', () => {
    it('when the zoom is 1 then the tile is the world spacing and a dot sits on the world origin', () => {
      const g = gridStyle({ x: 100, y: 50, zoom: 1 });

      expect(g.size, 'tile').toBe(GRID_SPACING);
      expect(g.x + g.size / 2, 'dot x = camera x').toBe(100);
      expect(g.y + g.size / 2, 'dot y = camera y').toBe(50);
    });

    it('when zoomed out then every n-th dot is dropped so the dots stay apart', () => {
      const g = gridStyle({ x: 0, y: 0, zoom: 0.1 });

      expect(g.size, 'tile').toBeGreaterThanOrEqual(18);
      expect(g.size, 'tile').toBeLessThan(36);
    });

    it('when zoomed in then the tile is halved so the dots do not drift apart', () => {
      const g = gridStyle({ x: 0, y: 0, zoom: 8 });

      expect(g.size, 'tile').toBeGreaterThanOrEqual(18);
      expect(g.size, 'tile').toBeLessThan(36);
    });

    it('when the density changes then every dot is still a multiple of the world spacing', () => {
      for (const zoom of [0.1, 0.3, 0.77, 1, 2.5, 8]) {
        const g = gridStyle({ x: 0, y: 0, zoom });
        const worldStep = g.size / zoom / GRID_SPACING;

        expect(Math.log2(worldStep) % 1, `zoom ${zoom}`).toBeCloseTo(0, 6);
      }
    });

    it('when zooming then the dot radius stays within a readable range', () => {
      expect(gridStyle({ x: 0, y: 0, zoom: 0.1 }).dot, 'min').toBeCloseTo(0.9);
      expect(gridStyle({ x: 0, y: 0, zoom: 8 }).dot, 'max').toBeCloseTo(1.6);
    });
  });

  describe('gridAlpha', () => {
    it('when zoomed far out then the dots fade and below the threshold are gone', () => {
      expect(gridAlpha(1), 'normal').toBe(1);
      expect(gridAlpha(GRID_FADE_FROM), 'fade starts').toBe(1);
      expect(gridAlpha((GRID_FADE_FROM + GRID_HIDDEN_BELOW) / 2), 'half way').toBeCloseTo(0.5);
      expect(gridAlpha(GRID_HIDDEN_BELOW - 0.001), 'hidden').toBe(0);
      expect(gridAlpha(0.02), 'at 2 %').toBe(0);
    });

    it('when the zoom is 2 % then the tile density still stays in range', () => {
      const g = gridStyle({ x: 0, y: 0, zoom: 0.02 });

      expect(g.size, 'tile').toBeGreaterThanOrEqual(18);
      expect(g.size, 'tile').toBeLessThan(36);
    });
  });

  describe('applyGrid', () => {
    it('when applied then the element gets a tiled background positioned by the camera', () => {
      const el = document.createElement('div');

      applyGrid(el, { x: 30, y: 10, zoom: 1 });

      expect(el.style.backgroundSize, 'size').toBe('24px 24px');
      expect(el.style.backgroundPosition, 'position').toBe('18px -2px');
    });

    it('when zoomed out below the threshold then no background is painted, in between it fades', () => {
      const el = document.createElement('div');

      applyGrid(el, { x: 0, y: 0, zoom: 0.02 });
      expect(el.style.backgroundImage, 'hidden').toBe('none');

      applyGrid(el, { x: 0, y: 0, zoom: (GRID_FADE_FROM + GRID_HIDDEN_BELOW) / 2 });
      expect(el.style.backgroundImage, 'faded').toContain('50%');

      applyGrid(el, { x: 0, y: 0, zoom: 1 });
      expect(el.style.backgroundImage, 'full').toContain('var(--be-grid-dot');
      expect(el.style.backgroundImage, 'full').not.toContain('color-mix');
    });
  });
});
