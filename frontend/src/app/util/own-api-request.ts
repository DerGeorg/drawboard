/**
 * True for requests to OUR backend only: relative URLs below the API base path ("/api/…").
 * Tokens must never go to third-party URLs - absolute and protocol-relative URLs never match.
 */
export function isOwnApiRequest(url: string, apiBaseUrl: string): boolean {
  const base = apiBaseUrl.replace(/\/$/, '');
  if (!url.startsWith('/') || url.startsWith('//')) {
    return false;
  }
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
}
