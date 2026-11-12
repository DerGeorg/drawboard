import { HANDLES, handleCursor, handlePosition, resizeRect } from './resize';

describe('resize', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };

  describe('handlePosition', () => {
    it('when handles are positioned then corners and sides are on the rectangle', () => {
      expect(handlePosition(r, 'nw'), 'nw').toEqual({ x: 100, y: 100 });
      expect(handlePosition(r, 'se'), 'se').toEqual({ x: 300, y: 200 });
      expect(handlePosition(r, 'n'), 'n').toEqual({ x: 200, y: 100 });
      expect(handlePosition(r, 'e'), 'e').toEqual({ x: 300, y: 150 });
      expect(HANDLES.length, 'eight handles').toBe(8);
    });

    it('when cursors are asked then each handle has a resize cursor', () => {
      expect(HANDLES.map(handleCursor), 'cursors').toEqual([
        'nwse-resize',
        'ns-resize',
        'nesw-resize',
        'ew-resize',
        'nwse-resize',
        'ns-resize',
        'nesw-resize',
        'ew-resize',
      ]);
    });
  });

  describe('resizeRect', () => {
    it('when dragging se then the origin stays', () => {
      expect(resizeRect(r, 'se', 50, 20), 'rect').toEqual({ x: 100, y: 100, w: 250, h: 120 });
    });

    it('when dragging nw then the opposite corner stays', () => {
      expect(resizeRect(r, 'nw', 20, 10), 'rect').toEqual({ x: 120, y: 110, w: 180, h: 90 });
    });

    it('when dragging a side then only one dimension changes', () => {
      expect(resizeRect(r, 'e', 10, 99), 'e').toEqual({ x: 100, y: 100, w: 210, h: 100 });
      expect(resizeRect(r, 'n', 99, -10), 'n').toEqual({ x: 100, y: 90, w: 200, h: 110 });
    });

    it('when dragged past the opposite side then the minimum size holds and the fixed side stays', () => {
      const out = resizeRect(r, 'w', 1000, 0);

      expect(out.w, 'width').toBe(24);
      expect(out.x + out.w, 'right edge').toBe(300);
    });

    it('when the aspect ratio is kept then a corner drag scales both sides', () => {
      const out = resizeRect(r, 'se', 100, 0, true);

      expect(out.w / out.h, 'ratio').toBeCloseTo(2);
      expect(out.w, 'width').toBe(300);
    });

    it('when the aspect ratio is kept and height dominates then width follows', () => {
      const out = resizeRect(r, 'se', 0, 100, true);

      expect(out.h, 'height').toBe(200);
      expect(out.w, 'width').toBe(400);
    });
  });
});
