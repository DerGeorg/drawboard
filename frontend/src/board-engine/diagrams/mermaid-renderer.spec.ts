import DOMPurify from 'dompurify';

import { mermaidRendering } from '../../trusted-types';
import { MAX_MERMAID_BYTES } from '@apps/drawboard-engine';
import { MERMAID_CONFIG, MermaidApi, mermaidRenderer, sanitizeSvg } from './mermaid-renderer';

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** Serialises nodes for assertions (never used to render). */
function markup(node: Node): string {
  const div = document.createElement('div');
  div.appendChild(node);
  return div.innerHTML;
}

describe('mermaid renderer', () => {
  function fakeMermaid(svg = `<svg ${NS}><g><text>ok</text></g></svg>`): {
    api: MermaidApi;
    configs: Record<string, unknown>[];
    sources: string[];
  } {
    const configs: Record<string, unknown>[] = [];
    const sources: string[] = [];
    return {
      configs,
      sources,
      api: {
        initialize: (c) => configs.push(c),
        render: (_id, text) => {
          sources.push(text);
          return text === 'broken'
            ? Promise.reject(new Error('Parse error'))
            : Promise.resolve({ svg });
        },
      },
    };
  }

  const renderer = (m: ReturnType<typeof fakeMermaid>) =>
    mermaidRenderer({
      load: () => Promise.resolve({ mermaid: m.api, purify: DOMPurify }),
      yieldToBoard: () => Promise.resolve(),
    });

  describe('trusted types (S3.12)', () => {
    it('when mermaid renders then it runs inside the render window of the default policy only', async () => {
      const m = fakeMermaid();
      const during: boolean[] = [];
      const render = m.api.render;
      m.api.render = (id, text) => {
        during.push(mermaidRendering());
        return render(id, text);
      };

      await renderer(m).render('graph TD; A-->B');
      await renderer(m)
        .render('broken')
        .catch(() => undefined);

      expect(during, 'both renders inside the window').toEqual([true, true]);
      expect(mermaidRendering(), 'window closed afterwards').toBe(false);
    });
  });

  describe('configuration (S5.1)', () => {
    it('when a diagram is rendered for the dark canvas then mermaid switches to its dark theme and back', async () => {
      const m = fakeMermaid();
      const r = renderer(m);

      await r.render('graph TD; A-->B', 'light');
      await r.render('graph TD; A-->B', 'dark');
      await r.render('graph TD; B-->C', 'dark');
      await r.render('graph TD; A-->B', 'light');

      expect(
        m.configs.map((c) => c['theme']),
        'initialisations',
      ).toEqual(['default', 'dark', 'default']);
      expect(m.configs[1]?.['securityLevel'], 'still strict in dark').toBe('strict');
      expect(m.configs[1]?.['htmlLabels'], 'still no HTML labels in dark').toBe(false);
    });

    it('when mermaid is first used then it is set up strict, without HTML labels and with the limits', async () => {
      const m = fakeMermaid();

      await renderer(m).render('graph TD; A-->B');

      const config = m.configs[0] ?? {};
      expect(m.configs.length, 'initialised once').toBe(1);
      expect(config['securityLevel'], 'strict').toBe('strict');
      expect(config['htmlLabels'], 'no HTML labels').toBe(false);
      expect(config['flowchart'], 'not for flowcharts either').toEqual({ htmlLabels: false });
      expect(config['maxTextSize'], 'text size').toBe(50_000);
      expect(config['maxEdges'], 'edges').toBe(500);
      expect(config['startOnLoad'], 'no scanning of the page').toBe(false);
    });

    it('when a diagram tries to change the security settings by directive then mermaid is told those keys are secure', () => {
      expect(MERMAID_CONFIG.secure, 'secure keys').toEqual(
        expect.arrayContaining([
          'securityLevel',
          'htmlLabels',
          'flowchart',
          'maxTextSize',
          'maxEdges',
          'themeCSS',
          'dompurifyConfig',
        ]),
      );
    });

    it('when the source is larger than 50 KB then mermaid is not even called', async () => {
      const m = fakeMermaid();

      await expect(
        renderer(m).render('x'.repeat(MAX_MERMAID_BYTES + 1)),
        'refused',
      ).rejects.toThrow('larger than 50 KB');
      expect(m.sources, 'not called').toEqual([]);
    });

    it('when renders overlap then they run one after the other and a failure does not stop the queue', async () => {
      const m = fakeMermaid();
      const r = renderer(m);

      const results = await Promise.allSettled([r.render('a'), r.render('broken'), r.render('c')]);

      expect(m.sources, 'in order').toEqual(['a', 'broken', 'c']);
      expect(
        results.map((x) => x.status),
        'states',
      ).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });
  });

  describe('sanitising (S5.1)', () => {
    it('when the SVG holds script, foreignObject, links and handlers then they are removed', () => {
      const hostile =
        `<svg ${NS} onload="alert(1)"><script>alert(2)</script>` +
        '<foreignObject><div>html</div></foreignObject>' +
        '<a href="https://evil.example"><text>link</text></a>' +
        '<g onclick="alert(3)"><text>kept</text></g></svg>';

      const out = markup(sanitizeSvg(DOMPurify, hostile));

      expect(out, 'no script').not.toContain('script');
      expect(out, 'no foreignObject').not.toMatch(/foreignobject/i);
      expect(out, 'no link').not.toContain('evil.example');
      expect(out, 'no handlers').not.toMatch(/onload|onclick/);
      expect(out, 'text kept').toContain('kept');
    });

    it('when CSS or attributes load something from outside then those URLs are neutralised', () => {
      const hostile =
        `<svg ${NS}><style>@import url(https://evil.example/a.css); .n{background:url(https://evil.example/p.png)} .m{marker-end:url(#arrow)}</style>` +
        '<image href="https://evil.example/i.png"/>' +
        '<use href="https://evil.example/s.svg#x"/><use href="#local"/>' +
        '<rect fill="url(https://evil.example/f)" marker-end="url(#arrow)"/></svg>';

      const out = markup(sanitizeSvg(DOMPurify, hostile));

      expect(out, 'nothing from outside').not.toContain('evil.example');
      expect(out, 'no import').not.toContain('@import');
      expect(out, 'local markers stay').toContain('url(#arrow)');
    });

    it('when CSS hides url() or @import behind escapes then they are removed', () => {
      const hostile =
        `<svg ${NS}><style>.a{background:\\75rl(https://x/p.png)} @\\69mport url(x); .b{fill:u\\72l(https://y/q)}</style>` +
        '<rect style="fill:\\75rl(https://z/f)" stroke="\\75rl(https://w/s)"/></svg>';

      const out = markup(sanitizeSvg(DOMPurify, hostile));

      expect(out, 'no backslash left').not.toContain('\\');
      expect(out, 'no import').not.toMatch(/@import/i);
      expect(out, 'escaped names are plain junk now, not functions').not.toMatch(/\burl\(/i);
    });

    it('when a clean diagram is sanitised then it scales with the block', () => {
      const root = sanitizeSvg(
        DOMPurify,
        `<svg ${NS} width="800" height="600" viewBox="0 0 800 600"><g/></svg>`,
      ).firstElementChild;

      expect(root?.getAttribute('width'), 'width').toBe('100%');
      expect(root?.hasAttribute('height'), 'no fixed height').toBe(false);
      expect(root?.getAttribute('viewBox'), 'view box kept').toBe('0 0 800 600');
    });

    it('when mermaid answers then the result is a sanitised fragment, not a string', async () => {
      const m = fakeMermaid(`<svg ${NS}><script>alert(1)</script><text>ok</text></svg>`);

      const node = await renderer(m).render('graph TD; A-->B');

      expect(node, 'fragment').toBeInstanceOf(DocumentFragment);
      expect(markup(node), 'sanitised').not.toContain('script');
    });
  });
});
