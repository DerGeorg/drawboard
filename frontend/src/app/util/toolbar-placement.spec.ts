import { TOOLBAR_GAP, TOOLBAR_HEIGHT, TOP_CLEARANCE, placeToolbar } from './toolbar-placement';

describe('placeToolbar', () => {
  const window = { w: 1000, h: 800 };

  describe('position', () => {
    it('when there is room above then the toolbar is centred above the selection', () => {
      const p = placeToolbar({ x: 300, y: 400, w: 200, h: 100 }, window);

      expect(p, 'placement').toEqual({
        x: 400,
        y: 400 - TOOLBAR_GAP - TOOLBAR_HEIGHT,
        below: false,
      });
    });

    it('when the selection is near the top then the toolbar goes below it', () => {
      const p = placeToolbar({ x: 300, y: 70, w: 200, h: 100 }, window);

      expect(p, 'placement').toEqual({ x: 400, y: 70 + 100 + TOOLBAR_GAP, below: true });
    });

    it('when the selection fills the window then the toolbar floats at the top', () => {
      const p = placeToolbar({ x: -50, y: -50, w: 1200, h: 1000 }, window);

      expect(p, 'placement').toEqual({ x: 550, y: TOP_CLEARANCE, below: false });
    });

    it('when the selection is partly off screen then the toolbar follows its centre', () => {
      const p = placeToolbar({ x: -100, y: 400, w: 200, h: 50 }, window);

      expect(p?.x, 'centre').toBe(0);
    });
  });

  describe('visibility', () => {
    it.each([
      ['left of', { x: -300, y: 300, w: 200, h: 100 }],
      ['right of', { x: 1100, y: 300, w: 200, h: 100 }],
      ['above', { x: 300, y: -300, w: 200, h: 100 }],
      ['below', { x: 300, y: 900, w: 200, h: 100 }],
    ])('when the selection is entirely %s the window then there is no toolbar', (_where, rect) => {
      expect(placeToolbar(rect, window), 'placement').toBeUndefined();
    });

    it('when the window is not measured yet then nothing is hidden', () => {
      expect(
        placeToolbar({ x: 5000, y: 5000, w: 10, h: 10 }, { w: 0, h: 0 }),
        'placement',
      ).toBeDefined();
    });
  });
});
