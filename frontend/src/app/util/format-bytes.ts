/** "512 B", "3.4 kB", "12 MB" - decimal units, one decimal below 10. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const text = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[unit]}`;
}
