/** Up to two capital letters for an avatar: first letters of the first and last word, "?" if empty. */
export function initials(name: string): string {
  // only words that start with a letter or digit: "Alice Admin (you)" -> "AA", not "A("
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(w));
  if (words.length === 0) {
    return '?';
  }
  const first = Array.from(words[0] as string)[0] ?? '';
  const last = words.length > 1 ? (Array.from(words[words.length - 1] as string)[0] ?? '') : '';
  return (first + last).toUpperCase();
}
