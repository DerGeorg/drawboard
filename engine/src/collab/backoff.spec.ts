import { backoffDelay } from './backoff.js';

describe('backoff', () => {
  describe('backoffDelay', () => {
    it.each([
      [0, 1000],
      [1, 2000],
      [2, 4000],
      [4, 16_000],
      [5, 30_000],
      [20, 30_000],
    ])('when attempt %i has no jitter then the delay is %i ms', (attempt, ms) => {
      expect(
        backoffDelay(attempt, () => 0.5),
        'delay',
      ).toBe(ms);
    });

    it('when jitter is at its extremes then the delay varies by 20 percent', () => {
      expect(
        backoffDelay(0, () => 0),
        'minimum',
      ).toBe(800);
      expect(
        backoffDelay(0, () => 0.999999),
        'maximum',
      ).toBeCloseTo(1200, -1);
    });

    it('when no random function is given then Math.random is used', () => {
      const d = backoffDelay(1);

      expect(d, 'inside the jitter range').toBeGreaterThanOrEqual(1600);
      expect(d, 'inside the jitter range').toBeLessThanOrEqual(2400);
    });
  });
});
