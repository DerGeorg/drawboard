import { relativeTime } from './relative-time';

describe('relativeTime', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const ago = (seconds: number): Date => new Date(now.getTime() - seconds * 1000);

  describe('past', () => {
    it.each([
      [5, 'just now'],
      [44, 'just now'],
      [90, '2 minutes ago'],
      [60 * 59, '59 minutes ago'],
      [3600, '1 hour ago'],
      [3600 * 5, '5 hours ago'],
      [86400, 'yesterday'],
      [86400 * 3, '3 days ago'],
      [86400 * 14, '2 weeks ago'],
      [86400 * 60, '2 months ago'],
      [86400 * 800, '2 years ago'],
    ])('when it was %i seconds ago then it reads "%s"', (seconds, expected) => {
      expect(relativeTime(ago(seconds), now), `${seconds} s`).toBe(expected);
    });
  });

  describe('input', () => {
    it('when given an ISO string then it is parsed', () => {
      expect(relativeTime('2026-11-09T11:00:00Z', now), 'string input').toBe('1 hour ago');
    });

    it('when the date is invalid then the result is empty', () => {
      expect(relativeTime('not a date', now), 'invalid input').toBe('');
    });

    it('when the clock is slightly ahead then it still reads "just now"', () => {
      expect(relativeTime(new Date(now.getTime() + 10_000), now), 'future').toBe('just now');
    });
  });
});
