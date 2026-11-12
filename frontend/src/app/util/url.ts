/** Drops query string and fragment: they may carry tokens, search terms or e-mail addresses. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}
