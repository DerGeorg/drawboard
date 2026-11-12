const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Rounds half away from zero (Math.round rounds -1.5 to -1: "1 minute ago" for 90 seconds). */
const round = (n: number): number => Math.sign(n) * Math.round(Math.abs(n));

const FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * "5 minutes ago", "yesterday", "3 weeks ago", "just now" for anything within the last
 * seconds. Dates are rounded to the largest unit that fits; `now` is a parameter so the
 * result is testable.
 */
export function relativeTime(then: Date | string, now: Date = new Date()): string {
  const seconds = (new Date(then).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);
  if (Number.isNaN(abs)) {
    return '';
  }
  if (abs < 45) {
    return 'just now';
  }
  if (abs < HOUR) {
    return FORMAT.format(round(seconds / MINUTE), 'minute');
  }
  if (abs < DAY) {
    return FORMAT.format(round(seconds / HOUR), 'hour');
  }
  if (abs < 7 * DAY) {
    return FORMAT.format(round(seconds / DAY), 'day');
  }
  if (abs < 30 * DAY) {
    return FORMAT.format(round(seconds / (7 * DAY)), 'week');
  }
  if (abs < 365 * DAY) {
    return FORMAT.format(round(seconds / (30 * DAY)), 'month');
  }
  return FORMAT.format(round(seconds / (365 * DAY)), 'year');
}
