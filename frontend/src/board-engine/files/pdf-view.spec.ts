import { FakeFileSource, FILE_ID, aFileMeta, someLinks } from '../testing/fake-file-source';
import { FileContent } from '../blocks/file';
import {
  MAX_PDF_BYTES,
  PdfFetchError,
  PdfJs,
  PdfLoadingTask,
  PdfWorker,
  pdfRenderers,
} from './pdf-view';

/** A pdf.js stand-in: records the options and renders nothing (jsdom has no canvas). */
function fakePdfJs(pages = 3): {
  lib: PdfJs;
  params: Record<string, unknown>[];
  rendered: number[];
  task: () => PdfLoadingTask;
} {
  const params: Record<string, unknown>[] = [];
  const rendered: number[] = [];
  let last: PdfLoadingTask | undefined;
  const lib: PdfJs = {
    GlobalWorkerOptions: { workerPort: null },
    AnnotationMode: { DISABLE: 0 },
    getDocument(p) {
      params.push(p);
      last = {
        promise: Promise.resolve({
          numPages: pages,
          getPage: (n: number) =>
            Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({
                width: 600 * scale,
                height: 800 * scale,
              }),
              render: (r: Record<string, unknown>) => {
                rendered.push(n);
                expect(r['annotationMode'], 'annotations never rendered').toBe(0);
                return { promise: Promise.resolve(), cancel: () => undefined };
              },
              cleanup: () => undefined,
            }),
          destroy: () => Promise.resolve(),
        }),
        destroy: vi.fn(() => Promise.resolve()),
      };
      return last;
    },
  };
  return { lib, params, rendered, task: () => last as PdfLoadingTask };
}

interface FakeWorker extends PdfWorker {
  url: string;
  terminate: ReturnType<typeof vi.fn<() => void>>;
}

/** A worker factory that records what it was asked to start. */
function fakeWorkers(): { workers: FakeWorker[]; createWorker: (url: string) => PdfWorker } {
  const workers: FakeWorker[] = [];
  return {
    workers,
    createWorker: (url) => {
      const worker: FakeWorker = { url, terminate: vi.fn<() => void>() };
      workers.push(worker);
      return worker;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe('pdf view', () => {
  let host: HTMLElement;
  let source: FakeFileSource;
  let fetched: string[];
  let started: ReturnType<typeof fakeWorkers>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    source = new FakeFileSource();
    fetched = [];
    started = fakeWorkers();
  });
  afterEach(() => host.remove());

  function mount(
    pdf = fakePdfJs(),
    fetchBytes: (url: string) => Promise<ArrayBuffer> = (url) => {
      fetched.push(url);
      return Promise.resolve(new ArrayBuffer(8));
    },
    links = someLinks(1, { pdfUrl: '/files/x?v=pdf&sig=p' }),
  ): FileContent {
    const renderers = pdfRenderers({
      assetBase: '/pdfjs/',
      load: () => Promise.resolve(pdf.lib),
      fetchBytes,
      createWorker: started.createWorker,
    });
    return renderers.pdf?.(host, aFileMeta({ kind: 'PDF', name: 'plan.pdf' }), links, {
      source,
      fileId: FILE_ID,
    }) as FileContent;
  }

  const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);

  describe('loading (S4.9)', () => {
    it('when a PDF is shown then pdf.js gets the bytes, never the URL, and everything from our origin', async () => {
      const pdf = fakePdfJs();
      mount(pdf);
      await flush();

      const p = pdf.params[0] ?? {};
      expect(
        started.workers.map((w) => w.url),
        'worker from our origin',
      ).toEqual(['/pdfjs/pdf.worker.min.mjs']);
      expect(pdf.lib.GlobalWorkerOptions.workerPort, 'handed over as a port').toBe(
        started.workers[0],
      );
      expect(p['data'], 'bytes').toBeInstanceOf(ArrayBuffer);
      expect(p['url'], 'no URL for pdf.js').toBeUndefined();
      expect(p['enableXfa'], 'no XFA').toBe(false);
      expect(p['isEvalSupported'], 'no eval switch: pdf.js 6 has no eval path').toBeUndefined();
      expect(p['disableWorkerRendering'], 'no second worker').toBe(true);
      expect(
        [p['cMapUrl'], p['standardFontDataUrl'], p['wasmUrl'], p['iccUrl']],
        'assets from our origin',
      ).toEqual(['/pdfjs/cmaps/', '/pdfjs/standard_fonts/', '/pdfjs/wasm/', '/pdfjs/iccs/']);
      expect(fetched, 'the converted PDF variant').toEqual(['/files/x?v=pdf&sig=p']);
      expect(pdf.rendered, 'first page').toEqual([1]);
    });

    it('when the file has no pdf variant then the displayed URL is used', async () => {
      mount(fakePdfJs(), undefined, someLinks(1));
      await flush();

      expect(fetched, 'url').toEqual([someLinks(1).url]);
    });
  });

  describe('pager', () => {
    it('when a PDF has several pages then the pager walks through them', async () => {
      const pdf = fakePdfJs(3);
      mount(pdf);
      await flush();

      const next = q<HTMLButtonElement>('button[aria-label="Next page of plan.pdf"]');
      const prev = q<HTMLButtonElement>('button[aria-label="Previous page of plan.pdf"]');
      expect(q('.be-pdf-label')?.textContent, 'first').toBe('1 / 3');
      expect(prev?.disabled, 'no previous on page 1').toBe(true);
      expect(next?.hasAttribute('data-be-interactive'), 'the canvas leaves the click alone').toBe(
        true,
      );

      next?.click();
      await flush();
      next?.click();
      await flush();
      next?.click();
      await flush();

      expect(q('.be-pdf-label')?.textContent, 'last').toBe('3 / 3');
      expect(next?.disabled, 'no next on the last page').toBe(true);
      expect(pdf.rendered, 'pages rendered').toEqual([1, 2, 3]);
      prev?.click();
      await flush();
      expect(q('.be-pdf-label')?.textContent, 'back').toBe('2 / 3');
    });

    it('when a PDF has one page then there is no pager', async () => {
      mount(fakePdfJs(1));
      await flush();

      expect(q<HTMLElement>('.be-pdf-pager')?.style.display, 'hidden').toBe('none');
    });
  });

  describe('failures', () => {
    it('when the signed URL expired then new URLs are fetched once and the PDF opens with them', async () => {
      let calls = 0;
      const pdf = fakePdfJs();
      const view = mount(pdf, (url) => {
        fetched.push(url);
        calls++;
        return calls === 1
          ? Promise.reject(new PdfFetchError(403))
          : Promise.resolve(new ArrayBuffer(4));
      });
      await flush();

      expect(source.refreshes, 'refresh').toEqual([FILE_ID]);
      view.update(aFileMeta({ kind: 'PDF' }), someLinks(2, { pdfUrl: '/files/x?sig=new' }));
      await flush();

      expect(fetched.at(-1), 'new URL').toBe('/files/x?sig=new');
      expect(pdf.rendered, 'rendered').toEqual([1]);
    });

    it('when the PDF cannot be loaded then the block says so without the URL and logs nothing', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mount(fakePdfJs(), () => Promise.reject(new PdfFetchError(500)));
      await flush();

      expect(q('.be-pdf-status')?.textContent, 'message').toContain('cannot be shown');
      expect(host.textContent, 'no URL').not.toContain('sig=');
      expect(log, 'no console error').not.toHaveBeenCalled();
      expect(warn, 'no console warning').not.toHaveBeenCalled();
      log.mockRestore();
      warn.mockRestore();
    });

    it('when the PDF has a password then the block says so instead of asking', async () => {
      const pdf = fakePdfJs();
      let returned: PdfLoadingTask | undefined;
      const lib: PdfJs = {
        ...pdf.lib,
        getDocument: () => {
          returned = {
            promise: new Promise(() => undefined),
            destroy: vi.fn(() => Promise.resolve()),
          };
          return returned;
        },
      };
      mount({ ...pdf, lib });
      await flush();

      (returned?.onPassword as () => void)();

      expect(q('.be-pdf-status')?.textContent, 'message').toContain('protected by a password');
      expect(returned?.destroy, 'loading stopped').toHaveBeenCalled();
    });

    it('when the PDF is larger than the limit then it is refused before it is read', () => {
      expect(MAX_PDF_BYTES, 'above the 50 MB upload cap').toBeGreaterThan(50_000_000);
      expect(new PdfFetchError(413).message, 'no URL in the message').toBe(
        'The PDF could not be fetched (HTTP 413).',
      );
    });
  });

  describe('worker (S3.12)', () => {
    afterEach(() => vi.unstubAllGlobals());

    const cardOf = (renderers: ReturnType<typeof pdfRenderers>, el: HTMLElement): FileContent =>
      renderers.pdf?.(el, aFileMeta({ kind: 'PDF' }), someLinks(1, { pdfUrl: '/files/x' }), {
        source,
        fileId: FILE_ID,
      }) as FileContent;

    it('when two PDFs are shown then one worker serves both', async () => {
      const pdf = fakePdfJs();
      const renderers = pdfRenderers({
        assetBase: '/pdfjs/',
        load: () => Promise.resolve(pdf.lib),
        fetchBytes: () => Promise.resolve(new ArrayBuffer(8)),
        createWorker: started.createWorker,
      });
      const other = document.createElement('div');

      cardOf(renderers, host);
      cardOf(renderers, other);
      await flush();

      expect(started.workers.length, 'workers').toBe(1);
      expect(pdf.params.length, 'documents').toBe(2);
    });

    it('when the renderers are destroyed then the worker is terminated and the port cleared', async () => {
      const pdf = fakePdfJs();
      const renderers = pdfRenderers({
        assetBase: '/pdfjs/',
        load: () => Promise.resolve(pdf.lib),
        fetchBytes: () => Promise.resolve(new ArrayBuffer(8)),
        createWorker: started.createWorker,
      });
      cardOf(renderers, host);
      await flush();

      renderers.destroy();
      await flush();

      expect(started.workers[0]?.terminate, 'terminated').toHaveBeenCalledTimes(1);
      expect(pdf.lib.GlobalWorkerOptions.workerPort, 'port cleared').toBeNull();
    });

    it('when the renderers are destroyed while pdf.js loads then no worker is left behind', async () => {
      const pdf = fakePdfJs();
      const renderers = pdfRenderers({
        assetBase: '/pdfjs/',
        load: () => Promise.resolve(pdf.lib),
        fetchBytes: () => Promise.resolve(new ArrayBuffer(8)),
        createWorker: started.createWorker,
      });

      cardOf(renderers, host);
      renderers.destroy();
      await flush();

      expect(started.workers.length, 'no worker started').toBe(0);
      expect(q('.be-pdf-status')?.textContent, 'the block says so').toContain('cannot be shown');
    });

    it('when no worker factory is given then a module worker of the asset base is started', async () => {
      const created: [unknown, unknown][] = [];
      vi.stubGlobal(
        'Worker',
        class {
          constructor(url: unknown, options: unknown) {
            created.push([url, options]);
          }
          terminate = vi.fn();
        },
      );
      const pdf = fakePdfJs();
      const renderers = pdfRenderers({
        assetBase: '/pdfjs/',
        load: () => Promise.resolve(pdf.lib),
        fetchBytes: () => Promise.resolve(new ArrayBuffer(8)),
      });

      cardOf(renderers, host);
      await flush();

      expect(created, 'new Worker(url, { type: module })').toEqual([
        ['/pdfjs/pdf.worker.min.mjs', { type: 'module' }],
      ]);
    });
  });

  describe('fetch', () => {
    afterEach(() => vi.unstubAllGlobals());

    function mountWithFetch(response: Response): ReturnType<typeof vi.fn> {
      const fetchSpy = vi.fn(() => Promise.resolve(response));
      vi.stubGlobal('fetch', fetchSpy);
      const pdf = fakePdfJs();
      pdfRenderers({
        assetBase: '/pdfjs/',
        load: () => Promise.resolve(pdf.lib),
        createWorker: started.createWorker,
      }).pdf?.(host, aFileMeta({ kind: 'PDF' }), someLinks(1), { source, fileId: FILE_ID });
      return fetchSpy;
    }

    it('when the bytes are fetched then no credentials and no referrer go along', async () => {
      const fetchSpy = mountWithFetch(new Response(new ArrayBuffer(4), { status: 200 }));
      await flush();

      expect(fetchSpy, 'fetch options').toHaveBeenCalledWith(someLinks(1).url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
    });

    it('when the server refuses the URL then new URLs are asked for', async () => {
      mountWithFetch(new Response(null, { status: 403 }));
      await flush();

      expect(source.refreshes, 'refresh').toEqual([FILE_ID]);
    });

    it('when the PDF is larger than the limit then it is not read', async () => {
      mountWithFetch(
        new Response('x', {
          status: 200,
          headers: { 'Content-Length': String(MAX_PDF_BYTES + 1) },
        }),
      );
      await flush();

      expect(q('.be-pdf-status')?.textContent, 'refused').toContain('cannot be shown');
    });
  });

  describe('lifecycle', () => {
    it('when the view is destroyed then the loading task is destroyed and the element removed', async () => {
      const pdf = fakePdfJs();
      const view = mount(pdf);
      await flush();

      view.destroy();

      expect(pdf.task().destroy, 'task destroyed').toHaveBeenCalled();
      expect(host.children.length, 'removed').toBe(0);
    });
  });
});
