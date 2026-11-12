/**
 * The largest font size from `max` down to `min` (steps of `step`) for which `fits` is true;
 * `min` if none fits (the text then clips instead of growing the note). `fits` must be
 * monotonic - a smaller size never fits worse - which allows a binary search: a sticky with a
 * long text measures about four sizes instead of all of them.
 */
export function fitFontSize(
  fits: (size: number) => boolean,
  max: number,
  min: number,
  step = 1,
): number {
  const count = Math.max(0, Math.floor((max - min) / step));
  // index 0 = max ... index count = min
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(max - mid * step)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return max - lo * step;
}
