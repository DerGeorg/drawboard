import {
  PDF_WORKER_PATH,
  TrustedTypePolicyFactory,
  TrustedTypePolicyOptions,
  createTrustedTypePolicies,
} from './trusted-types';

const ORIGIN = 'https://draw.example.org';

/** A factory that keeps the options of the policies it is asked to create. */
function fakeFactory(): {
  factory: TrustedTypePolicyFactory;
  options: Map<string, TrustedTypePolicyOptions>;
} {
  const options = new Map<string, TrustedTypePolicyOptions>();
  return {
    options,
    factory: {
      createPolicy(name, o) {
        if (options.has(name)) {
          throw new TypeError(`duplicate policy ${name}`);
        }
        options.set(name, o);
        return { createScriptURL: (input) => o.createScriptURL?.(input) };
      },
    },
  };
}

describe('trusted types (S3.12)', () => {
  describe('policy default', () => {
    function setUp() {
      const f = fakeFactory();
      const policies = createTrustedTypePolicies(f.factory, ORIGIN);
      const html = (input: string, sink?: string): string | undefined =>
        f.options.get('default')?.createHTML?.(input, 'TrustedHTML', sink);
      return { f, policies, html };
    }

    it('when the policies are created then exactly default and drawboard exist', () => {
      const { f } = setUp();

      expect([...f.options.keys()].sort(), 'policy names of the CSP').toEqual([
        'default',
        'drawboard',
      ]);
    });

    it('when mermaid renders then CSS text may go to Element innerHTML', async () => {
      const { policies, html } = setUp();

      await policies.duringMermaidRender(() => {
        expect(policies.rendering(), 'inside the render').toBe(true);
        expect(html('.node{fill:red}', 'Element innerHTML'), 'sink named').toBe('.node{fill:red}');
        expect(html('.node{fill:red}'), 'sink unnamed (direct call)').toBe('.node{fill:red}');
        return Promise.resolve();
      });

      expect(policies.rendering(), 'after the render').toBe(false);
    });

    it('when mermaid renders then markup and other sinks are still refused', async () => {
      const { policies, html } = setUp();

      await policies.duringMermaidRender(() => {
        expect(() => html('<img src=x onerror=alert(1)>', 'Element innerHTML'), '<').toThrow(
          TypeError,
        );
        expect(() => html('<', 'Element innerHTML'), 'a lone <').toThrow(TypeError);
        expect(() => html('a{}', 'Element outerHTML'), 'outerHTML').toThrow(TypeError);
        expect(() => html('a{}', 'HTMLIFrameElement srcdoc'), 'srcdoc').toThrow(TypeError);
        expect(() => html('a{}', 'Range createContextualFragment'), 'fragment').toThrow(TypeError);
        return Promise.resolve();
      });
    });

    it('when no render runs then every string is refused, markup or not', () => {
      const { html } = setUp();

      expect(() => html('.node{fill:red}', 'Element innerHTML'), 'plain text').toThrow(TypeError);
      expect(() => html('<b>x</b>', 'Element innerHTML'), 'markup').toThrow(TypeError);
    });

    it('when a render fails then the window closes anyway', async () => {
      const { policies, html } = setUp();

      await expect(
        policies.duringMermaidRender(() => Promise.reject(new Error('Parse error'))),
        'the error passes',
      ).rejects.toThrow('Parse error');

      expect(policies.rendering(), 'closed').toBe(false);
      expect(() => html('a{}', 'Element innerHTML'), 'refused again').toThrow(TypeError);
    });

    it('when two renders overlap then the window stays open until both are done', async () => {
      const { policies } = setUp();
      let finishFirst: () => void = () => undefined;
      const first = policies.duringMermaidRender(
        () => new Promise<void>((resolve) => (finishFirst = resolve)),
      );
      await policies.duringMermaidRender(() => Promise.resolve());

      expect(policies.rendering(), 'first still running').toBe(true);
      finishFirst();
      await first;
      expect(policies.rendering(), 'both done').toBe(false);
    });

    it('when a script or a script URL is created then the default policy always throws', () => {
      const { f } = setUp();
      const policy = f.options.get('default');

      expect(() => policy?.createScript?.('alert(1)'), 'createScript').toThrow(TypeError);
      expect(() => policy?.createScriptURL?.('/pdfjs/pdf.worker.min.mjs'), 'script URL').toThrow(
        TypeError,
      );
    });
  });

  describe('policy drawboard', () => {
    const url = (input: string): unknown => {
      const f = fakeFactory();
      return createTrustedTypePolicies(f.factory, ORIGIN).scriptUrls?.createScriptURL(input);
    };

    it('when the pdf.js worker of our origin is asked for then it is allowed', () => {
      expect(url(PDF_WORKER_PATH), 'root-relative').toBe(`${ORIGIN}${PDF_WORKER_PATH}`);
      expect(url(`${ORIGIN}${PDF_WORKER_PATH}`), 'absolute').toBe(`${ORIGIN}${PDF_WORKER_PATH}`);
    });

    it('when any other script URL is asked for then it is refused', () => {
      const refused = [
        'https://evil.example.com/pdfjs/pdf.worker.min.mjs',
        `${ORIGIN}.evil.example.com${PDF_WORKER_PATH}`,
        'https://user@draw.example.org/pdfjs/pdf.worker.min.mjs',
        '/pdfjs/pdf.worker.min.mjs?x=1',
        '/pdfjs/pdf.worker.min.mjs#x',
        '/pdfjs/pdf.worker.mjs',
        '/pdfjs/../main.js',
        '/pdfjs/pdf.worker.min.mjs/',
        '/files/x',
        '//evil.example.com/pdfjs/pdf.worker.min.mjs',
        'blob:https://draw.example.org/1234',
        'data:text/javascript,alert(1)',
        'javascript:alert(1)',
        '',
      ];

      for (const input of refused) {
        expect(() => url(input), `refused: ${input}`).toThrow(TypeError);
      }
    });
  });

  describe('without Trusted Types', () => {
    it('when the browser has none then nothing is created and renders still run', async () => {
      const policies = createTrustedTypePolicies(undefined, ORIGIN);

      expect(policies.scriptUrls, 'no script URL policy').toBeUndefined();
      await expect(
        policies.duringMermaidRender(() => Promise.resolve(7)),
        'result',
      ).resolves.toBe(7);
    });
  });
});
