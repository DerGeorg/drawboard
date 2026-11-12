export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_JITTER = 0.2;

/**
 * Reconnect delay: 1 s, doubling to 30 s, +-20 % jitter. `random` returns [0, 1).
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(base * jitter);
}
