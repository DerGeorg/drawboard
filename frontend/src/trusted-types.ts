/**
 * Trusted Types for the main app (architecture S3.12, decided in the M4 frontend review).
 *
 * The CSP says `require-trusted-types-for 'script'; trusted-types angular dompurify drawboard
 * default`. Angular ('angular') and DOMPurify ('dompurify') make their own policies; this file
 * makes the other two and is the FIRST import of `main.ts`, so no other code runs before the
 * `default` policy exists:
 *
 *  - `default`: the policy the browser falls back to when a string reaches a sink. It answers
 *    `createHTML` only while a Mermaid render runs, only for the `Element innerHTML` sink (or
 *    an unnamed one) and only for text without `<` - Mermaid writes its CSS into `<style>`
 *    elements that way. Everything else, and every script or script URL, is refused. DOMPurify
 *    output is NOT covered: it never calls the `default` policy.
 *  - `drawboard`: `createScriptURL` for exactly the pdf.js worker file of our own origin, no
 *    query, no fragment (pdf.js is started as `new Worker(url, { type: 'module' })`).
 *
 * No `'allow-duplicates'` and no `angular#unsafe-bypass` (the CSP check script keeps it so).
 */

/** The part of the Trusted Types API used here (lib.dom of this TypeScript has none of it). */
export interface TrustedTypePolicyOptions {
  createHTML?: (input: string, ...args: unknown[]) => string;
  createScript?: (input: string, ...args: unknown[]) => string;
  createScriptURL?: (input: string, ...args: unknown[]) => string;
}

export interface TrustedTypePolicy {
  createScriptURL(input: string): unknown;
}

export interface TrustedTypePolicyFactory {
  createPolicy(name: string, options: TrustedTypePolicyOptions): TrustedTypePolicy;
}

/** The worker file the `drawboard` policy lets through (copied by angular.json to `/pdfjs/`). */
export const PDF_WORKER_PATH = '/pdfjs/pdf.worker.min.mjs';

/** The sinks `default` answers while Mermaid renders; `undefined` is a direct policy call. */
const MERMAID_SINKS = new Set<string | undefined>(['Element innerHTML', undefined]);

export interface TrustedTypePolicies {
  /** Renders run inside `duringMermaidRender` may use `default.createHTML` (see above). */
  duringMermaidRender<T>(render: () => Promise<T>): Promise<T>;
  /** True while a render started through `duringMermaidRender` runs (tests, diagnostics). */
  rendering(): boolean;
  /** For `new Worker(...)` of the pdf.js worker; `undefined` where Trusted Types do not exist. */
  readonly scriptUrls: TrustedTypePolicy | undefined;
}

/**
 * Creates the two policies on `factory` (the page's `window.trustedTypes`; `undefined` in
 * browsers or tests without Trusted Types - then nothing is enforced and nothing is needed).
 * `origin` is the page's origin, the only one the worker URL may have.
 */
export function createTrustedTypePolicies(
  factory: TrustedTypePolicyFactory | undefined,
  origin: string,
): TrustedTypePolicies {
  let renders = 0;
  const duringMermaidRender = async <T>(render: () => Promise<T>): Promise<T> => {
    renders++;
    try {
      return await render();
    } finally {
      renders--;
    }
  };
  if (!factory) {
    return { duringMermaidRender, rendering: () => renders > 0, scriptUrls: undefined };
  }
  factory.createPolicy('default', {
    createHTML: (input, _type, sink) => {
      if (renders > 0 && MERMAID_SINKS.has(sink as string | undefined) && !input.includes('<')) {
        return input;
      }
      throw new TypeError('Trusted Types: this HTML is not allowed here.');
    },
    createScript: () => {
      throw new TypeError('Trusted Types: scripts are not allowed.');
    },
    createScriptURL: () => {
      throw new TypeError('Trusted Types: script URLs are not allowed here.');
    },
  });
  const scriptUrls = factory.createPolicy('drawboard', {
    createScriptURL: (input) => {
      if (/[?#]/.test(input)) {
        throw new TypeError('Trusted Types: the worker URL has no query or fragment.');
      }
      let url: URL;
      try {
        url = new URL(input, origin);
      } catch {
        throw new TypeError('Trusted Types: not a valid worker URL.');
      }
      if (
        url.origin !== origin ||
        url.pathname !== PDF_WORKER_PATH ||
        url.username !== '' ||
        url.password !== ''
      ) {
        throw new TypeError('Trusted Types: this script URL is not allowed.');
      }
      return url.href;
    },
  });
  return { duringMermaidRender, rendering: () => renders > 0, scriptUrls };
}

const policies = createTrustedTypePolicies(
  (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes,
  typeof location === 'undefined' ? 'null' : location.origin,
);

export const duringMermaidRender = policies.duringMermaidRender;
export const mermaidRendering = policies.rendering;
export const scriptUrls = policies.scriptUrls;
