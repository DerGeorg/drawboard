import { glideCamera, screenToWorld } from './camera';
import { TestEngine, createTestEngine } from './testing/helpers';

/** What following needs from the engine: a smooth camera move, and knowing what the user did. */
describe('BoardEngine following support', () => {
  let t: TestEngine;
  let navigated: number;

  beforeEach(() => {
    t = createTestEngine();
    t.engine.setViewportSize({ w: 800, h: 600 });
    navigated = 0;
    t.engine.navigated.on(() => navigated++);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    t.destroy();
  });

  describe('navigated', () => {
    it('when the user wheels, pinches, zooms or fits then navigated fires', () => {
      t.engine.wheel({ screen: { x: 10, y: 10 }, deltaX: 5, deltaY: 5, zoom: false });
      t.engine.wheel({ screen: { x: 10, y: 10 }, deltaX: 0, deltaY: 5, zoom: true });
      t.engine.pinch({ x: 0, y: 0 }, 1.1, 0, 0);
      t.engine.zoomIn();
      t.engine.zoomOut();
      t.engine.resetZoom();
      t.engine.fit();
      t.key('-', { mod: true });

      expect(navigated, 'count').toBe(8);
    });

    it('when the user drags with the hand tool then navigated fires', () => {
      t.engine.setTool('hand');
      const before = navigated;

      t.drag({ x: 0, y: 0 }, { x: 50, y: 50 });

      expect(navigated, 'panned').toBeGreaterThan(before);
    });

    it('when the camera glides to a followed view then navigated does not fire', () => {
      t.engine.glideTo({ x: 1000, y: 500 }, 0.5);

      expect(navigated, 'not a user action').toBe(0);
    });
  });

  describe('glideTo', () => {
    it('when there is no animation frame then the camera jumps to the centre and zoom', () => {
      vi.stubGlobal('requestAnimationFrame', undefined);

      t.engine.glideTo({ x: 1000, y: 500 }, 0.5);

      expect(t.engine.camera.zoom, 'zoom').toBe(0.5);
      expect(screenToWorld(t.engine.camera, { x: 400, y: 300 }), 'centre').toEqual({
        x: 1000,
        y: 500,
      });
    });

    it('when animation frames run then the camera approaches the target and ends exactly on it', () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
      vi.stubGlobal('cancelAnimationFrame', () => undefined);

      t.engine.glideTo({ x: 1000, y: 0 }, 2);
      let time = 0;
      const xs: number[] = [];
      for (let i = 0; i < 200 && frames.length > 0; i++) {
        time += 16;
        frames.shift()?.(time);
        xs.push(screenToWorld(t.engine.camera, { x: 400, y: 300 }).x);
      }

      expect(
        xs.some((x) => x > 0 && x < 999),
        'in between: not there at once',
      ).toBe(true);
      expect(t.engine.camera.zoom, 'zoom reached').toBe(2);
      expect(xs.at(-1), 'centre reached').toBeCloseTo(1000, 6);
      expect(frames.length, 'animation finished').toBe(0);
    });

    it('when the user navigates during a glide then the glide stops', () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
      vi.stubGlobal('cancelAnimationFrame', () => frames.splice(0));
      t.engine.glideTo({ x: 1000, y: 0 }, 2);

      t.engine.setCamera({ x: 0, y: 0, zoom: 1 });
      frames.shift()?.(16);

      expect(t.engine.camera, 'user camera kept').toEqual({ x: 0, y: 0, zoom: 1 });
    });
  });

  describe('glideCamera', () => {
    it('when a step is taken then the zoom moves in log space and a long step reaches the target', () => {
      const from = { x: 0, y: 0, zoom: 1 };
      const target = { x: 0, y: 0, zoom: 4 };
      const step = glideCamera(from, target, 110, { w: 0, h: 0 });

      // one time constant: 1 - 1/e of the way in log space
      expect(Math.log(step.zoom) / Math.log(4), 'log fraction').toBeCloseTo(1 - Math.exp(-1), 3);
      expect(glideCamera(from, target, 10_000, { w: 0, h: 0 }), 'reached').toBe(target);
    });
  });
});
