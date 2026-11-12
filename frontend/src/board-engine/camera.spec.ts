import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitToRect,
  panBy,
  screenToWorld,
  setZoomAt,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from './camera';

describe('camera', () => {
  const cam = { x: 100, y: 50, zoom: 2 };

  describe('coordinate conversion', () => {
    it('when converting world to screen and back then the point is unchanged', () => {
      const back = screenToWorld(cam, worldToScreen(cam, { x: 7, y: -3 }));

      expect(back, 'round trip').toEqual({ x: 7, y: -3 });
    });

    it('when the world origin is converted then it appears at the camera offset', () => {
      expect(worldToScreen(cam, { x: 0, y: 0 }), 'origin').toEqual({ x: 100, y: 50 });
    });
  });

  describe('zoomAt', () => {
    it('when zooming around a point then that point stays under the cursor', () => {
      const p = { x: 300, y: 200 };
      const before = screenToWorld(cam, p);

      const next = zoomAt(cam, p, 1.5);

      const after = screenToWorld(next, p);
      expect(after.x, 'world x under the cursor').toBeCloseTo(before.x);
      expect(after.y, 'world y under the cursor').toBeCloseTo(before.y);
      expect(next.zoom, 'zoom').toBe(3);
    });

    it('when zooming beyond the limits then the zoom is clamped', () => {
      expect(zoomAt(cam, { x: 0, y: 0 }, 100).zoom, 'max').toBe(MAX_ZOOM);
      expect(zoomAt(cam, { x: 0, y: 0 }, 0.0001).zoom, 'min').toBe(MIN_ZOOM);
      expect(clampZoom(1), 'inside').toBe(1);
    });

    it('when zooming out then the limit is 2 % (Miro-like), zooming in stays at 800 %', () => {
      expect(MIN_ZOOM, 'min').toBe(0.02);
      expect(MAX_ZOOM, 'max').toBe(8);
      expect(clampZoom(0.05), 'below the old 10 %').toBe(0.05);
    });

    it('when an absolute zoom is set then the factor is derived', () => {
      expect(setZoomAt(cam, { x: 0, y: 0 }, 1).zoom, 'zoom').toBe(1);
    });
  });

  describe('panBy and visibleWorldRect', () => {
    it('when panning then the offset moves by the delta', () => {
      expect(panBy(cam, 5, -5), 'camera').toEqual({ x: 105, y: 45, zoom: 2 });
    });

    it('when computing the visible rectangle then it is in world units', () => {
      expect(visibleWorldRect(cam, { w: 400, h: 200 }), 'rect').toEqual({
        x: -50,
        y: -25,
        w: 200,
        h: 100,
      });
    });
  });

  describe('fitToRect', () => {
    it('when content is small then the zoom stops at 1.5 and the content is centered', () => {
      const c = fitToRect({ x: 0, y: 0, w: 10, h: 10 }, { w: 800, h: 600 });

      expect(c.zoom, 'zoom').toBe(1.5);
      expect(worldToScreen(c, { x: 5, y: 5 }), 'center').toEqual({ x: 400, y: 300 });
    });

    it('when content is large then it is scaled down to fit', () => {
      const c = fitToRect({ x: 0, y: 0, w: 4000, h: 1000 }, { w: 800, h: 600 });

      expect(c.zoom, 'zoom').toBeLessThan(0.25);
    });

    it('when there is no content then zoom is 1 around the point', () => {
      expect(fitToRect({ x: 0, y: 0, w: 0, h: 0 }, { w: 800, h: 600 }).zoom, 'zoom').toBe(1);
    });
  });
});
