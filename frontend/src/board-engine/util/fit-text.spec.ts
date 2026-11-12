import { fitFontSize } from './fit-text';

describe('fitFontSize', () => {
  describe('result', () => {
    it('when the largest size fits then it is used', () => {
      expect(
        fitFontSize(() => true, 32, 10, 2),
        'size',
      ).toBe(32);
    });

    it('when only smaller sizes fit then the largest of those is used', () => {
      expect(
        fitFontSize((s) => s <= 18, 32, 10, 2),
        'size',
      ).toBe(18);
    });

    it('when a size between the steps would fit then the next step down is used', () => {
      expect(
        fitFontSize((s) => s <= 19, 32, 10, 2),
        'size',
      ).toBe(18);
    });

    it('when nothing fits then the minimum is used', () => {
      expect(
        fitFontSize(() => false, 32, 10, 2),
        'size',
      ).toBe(10);
    });

    it('when the range is a single size then it is returned', () => {
      expect(
        fitFontSize(() => false, 12, 12),
        'size',
      ).toBe(12);
    });

    it('when measuring then it needs far fewer checks than there are sizes', () => {
      let calls = 0;
      fitFontSize(
        (s) => {
          calls++;
          return s <= 11;
        },
        100,
        1,
      );

      expect(calls, 'measurements').toBeLessThanOrEqual(8);
    });
  });
});
