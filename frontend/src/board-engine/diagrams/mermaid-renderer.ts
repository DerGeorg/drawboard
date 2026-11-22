import type { Config as PurifyConfig, DOMPurify } from 'dompurify';

import { duringMermaidRender } from '../../trusted-types';
import { DiagramRenderer, byteLength } from '../blocks/mermaid';
import { MAX_MERMAID_BYTES, type BoardTheme } from '@apps/drawboard-engine';

/**
 * Mermaid (MIT) behind the diagram block, set up as S5.1 demands, and DOMPurify (Apache-2.0
 * licence option) on everything it produces. Both are loaded lazily in their own chunk the
 * first time a diagram renders.
 */

/** The configuration of S5.1. Diagram directives (`%%{init}%%`, front matter) cannot change it. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  maxTextSize: 50_000,
  maxEdges: 500,
  suppressErrorRendering: true,
  deterministicIds: true,
  theme: 'default',
  fontFamily: 'system-ui, sans-serif',
  // keys a diagram may never set for itself: mermaid's defaults plus everything that could
  // switch HTML labels back on, inject CSS (url() would leak the viewer's address) or loosen
  // the sanitiser
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'maxEdges',
    'suppressErrorRendering',
    'htmlLabels',
    'flowchart',
    'themeCSS',
    'fontFamily',
    'altFontFamily',
    'dompurifyConfig',
    'deterministicIds',
  ],
} as const;

/** DOMPurify on the SVG (S5.1): SVG profiles only, never foreignObject, script or links. */
export const PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'a', 'image', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
};

/** The part of mermaid this renderer uses. */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

export interface MermaidRendererOptions {
  load?: () => Promise<{ mermaid: MermaidApi; purify: DOMPurify }>;
  /** Yields to the board before every render (default: a macrotask). */
  yieldToBoard?: () => Promise<void>;
}

/** A `url(...)` that points anywhere but at an element of the same SVG (`url(#marker)`). */
const FOREIGN_URL = /url\(\s*(?!['"]?#)[^)]*\)/gi;
const IMPORT = /@import[^;]*;?/gi;
/**
 * CSS escapes (`\75rl(`, `@\69mport`) would hide `url(` and `@import` from the checks above.
 * Mermaid output never needs one, so every backslash goes before anything is checked.
 */
const CSS_ESCAPE = /\\/g;

/**
 * Renders diagram source to sanitised SVG nodes. One render at a time (mermaid keeps global
 * state), each after yielding to the board, so typing and drawing are never blocked by it.
 * The result is a DOM fragment from DOMPurify - the caller appends it; nothing is ever
 * assigned to `innerHTML`.
 */
export function mermaidRenderer(options: MermaidRendererOptions = {}): DiagramRenderer {
  const load = options.load ?? defaultLoad;
  const yieldToBoard = options.yieldToBoard ?? (() => new Promise((r) => setTimeout(r, 0)));
  let ready: Promise<{ mermaid: MermaidApi; purify: DOMPurify }> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let counter = 0;
  // Mermaid keeps one global configuration: the theme it was initialised with (light first)
  let configured: BoardTheme = 'light';

  /** Mermaid's own dark theme on the dark canvas; everything else of the S5.1 config stays. */
  const useTheme = (mermaid: MermaidApi, theme: BoardTheme): void => {
    if (theme !== configured) {
      configured = theme;
      mermaid.initialize({
        ...(structuredClone(MERMAID_CONFIG) as unknown as Record<string, unknown>),
        theme: theme === 'dark' ? 'dark' : 'default',
      });
    }
  };

  const libs = (): Promise<{ mermaid: MermaidApi; purify: DOMPurify }> => {
    ready ??= load().then((l) => {
      l.mermaid.initialize(structuredClone(MERMAID_CONFIG) as unknown as Record<string, unknown>);
      return l;
    });
    ready.catch(() => (ready = undefined));
    return ready;
  };

  return {
    render(source: string, theme: BoardTheme = 'light'): Promise<Node> {
      if (byteLength(source) > MAX_MERMAID_BYTES) {
        return Promise.reject(new Error('The diagram source is larger than 50 KB.'));
      }
      const run = async (): Promise<Node> => {
        await yieldToBoard();
        const { mermaid, purify } = await libs();
        useTheme(mermaid, theme);
        // Mermaid writes its CSS into <style> elements through innerHTML: the Trusted Types
        // `default` policy allows that, and only that, while this runs (S3.12)
        const { svg } = await duringMermaidRender(() =>
          mermaid.render(`be-mermaid-${++counter}`, source),
        );
        return sanitizeSvg(purify, svg);
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

/**
 * DOMPurify with the S5.1 profile, then more rules DOMPurify does not know: CSS escapes are
 * removed from style text and attribute values first, then no CSS that loads something from
 * outside is left (`url(...)` other than `#id`, `@import`), and no `href` that is not a
 * reference inside the SVG. The caller puts the result in a shadow root, which scopes whatever
 * `<style>` is left to the diagram (a stray `}` can no longer escape mermaid's `#id` scope).
 */
export function sanitizeSvg(purify: DOMPurify, svg: string): DocumentFragment {
  const fragment = purify.sanitize(svg, {
    ...PURIFY_CONFIG,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment;
  const elements = Array.from(fragment.querySelectorAll('*'));
  for (const el of elements) {
    if (el.localName === 'style') {
      el.textContent = (el.textContent ?? '')
        .replace(CSS_ESCAPE, '')
        .replace(IMPORT, '')
        .replace(FOREIGN_URL, 'none');
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if ((name === 'href' || name === 'xlink:href') && !attr.value.trim().startsWith('#')) {
        el.removeAttribute(attr.name);
      } else {
        // presentation attributes and `style` are parsed as CSS, escapes included
        const value = attr.value.replace(CSS_ESCAPE, '');
        const clean = value.replace(FOREIGN_URL, 'none');
        if (clean !== attr.value) {
          el.setAttribute(attr.name, clean);
        }
      }
    }
  }
  const root = fragment.firstElementChild;
  if (root?.localName === 'svg') {
    // fit the block: the view box scales, the block decides the size
    root.removeAttribute('height');
    root.setAttribute('width', '100%');
    root.setAttribute('style', 'max-width:100%;max-height:100%');
  }
  return fragment;
}

async function defaultLoad(): Promise<{ mermaid: MermaidApi; purify: DOMPurify }> {
  const [m, p] = await Promise.all([import('mermaid'), import('dompurify')]);
  return { mermaid: m.default as unknown as MermaidApi, purify: p.default };
}
