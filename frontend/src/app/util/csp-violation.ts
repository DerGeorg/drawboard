/**
 * What a `securitypolicyviolation` event may tell the telemetry (S3.12): which directive was
 * hit, whether it was enforced or only reported, and the ORIGIN of the blocked resource. Never
 * `sample` (it can hold script or markup) and never the full `blockedURI` (paths and queries can
 * hold share-link tokens, S7.2).
 */
export interface CspViolation {
  readonly violatedDirective: string;
  readonly effectiveDirective: string;
  readonly disposition: string;
  readonly blockedURI: string;
}

export type CspViolationAttributes = Record<
  'violatedDirective' | 'effectiveDirective' | 'disposition' | 'blockedOrigin',
  string
>;

/** `blockedURI` values that are no URL but a keyword of the CSP spec. */
const KEYWORDS = new Set([
  'inline',
  'eval',
  'wasm-eval',
  'data',
  'blob',
  'filesystem',
  'trusted-types-policy',
  'trusted-types-sink',
  'self',
]);

/** The origin of a blocked URI, or its CSP keyword, or `unknown`; never a path or query. */
export function blockedOrigin(blockedURI: string): string {
  if (blockedURI === '') {
    return 'none';
  }
  if (KEYWORDS.has(blockedURI)) {
    return blockedURI;
  }
  try {
    const url = new URL(blockedURI);
    return url.origin === 'null' ? url.protocol : url.origin;
  } catch {
    return 'unknown';
  }
}

export function cspViolationAttributes(event: CspViolation): CspViolationAttributes {
  return {
    violatedDirective: event.violatedDirective,
    effectiveDirective: event.effectiveDirective,
    disposition: event.disposition,
    blockedOrigin: blockedOrigin(event.blockedURI),
  };
}

/** Sends every violation of the page to `send`; returns the function that stops it. */
export function reportCspViolations(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  send: (name: string, attributes: CspViolationAttributes) => void,
): () => void {
  const listener = (event: Event): void =>
    send('csp_violation', cspViolationAttributes(event as unknown as CspViolation));
  target.addEventListener('securitypolicyviolation', listener);
  return () => target.removeEventListener('securitypolicyviolation', listener);
}
