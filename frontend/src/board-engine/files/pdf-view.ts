import { scriptUrls } from '../../trusted-types';
import { FileContent, FileContentContext, FileRenderers, INTERACTIVE_ATTR } from '../blocks/file';
import { FileLinks, FileMeta } from '@apps/drawboard-engine';

/**
 * PDFs and converted Office documents on the board, rendered with pdf.js (Apache-2.0) to a
 * canvas, page by page (architecture 3.6, S4.9). pdf.js lives in its own lazy chunk: it is
 * loaded the first time a PDF block mounts, never with the app.
 *
 * Security setup (S4.9):
 *  - worker, standard fonts, CMaps, ICC profiles and the image-decoder wasm come from our own
 *    origin (`assetBase`, copied from the package by angular.json) - CSP `worker-src 'self'`;
 *  - the worker is created by us, as a module worker from a Trusted Types script URL (S3.12:
 *    the `drawboard` policy accepts exactly `/pdfjs/pdf.worker.min.mjs`) and handed to pdf.js as
 *    `workerPort`, so pdf.js never starts a worker from a string. One worker for all PDFs of
 *    the renderer, terminated by `destroy()`;
 *  - no eval: pdf.js 6 has no code path that compiles fonts or functions with `eval`/`Function`
 *    any more (its `isEvalSupported` switch was removed with it), and the app's CSP has no
 *    `'unsafe-eval'` to fall back on;
 *  - no scripting: the annotation layer (where `enableScripting` lives) is never created, the
 *    scripting sandbox (`pdf.sandbox`, QuickJS) is not shipped, annotations are not rendered
 *    (`AnnotationMode.DISABLE`);
 *  - no XFA (`enableXfa: false`);
 *  - the bytes are fetched by us with the signed URL (no credentials, no referrer) and handed to
 *    pdf.js as data, so pdf.js never sees a URL - none can end up in its logs or errors.
 */

/** The part of the pdf.js module this view uses (tests hand in a fake). */
export interface PdfJs {
  GlobalWorkerOptions: { workerPort: PdfWorker | null };
  AnnotationMode: { DISABLE: number };
  getDocument(params: Record<string, unknown>): PdfLoadingTask;
}

/** The worker pdf.js talks to (a `Worker`; tests hand in a fake). */
export interface PdfWorker {
  terminate(): void;
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  onPassword?: unknown;
  destroy(): Promise<void>;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

export interface PdfPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: Record<string, unknown>): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}

export interface PdfOptions {
  /** Where the copied pdf.js assets are served, ending in `/` (e.g. `/pdfjs/`). */
  assetBase: string;
  /** Loads pdf.js; the default is the lazy chunk of `pdfjs-dist`. */
  load?: () => Promise<PdfJs>;
  /** Fetches the bytes; the default is `fetch` without credentials and referrer. */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** Starts the pdf.js worker; the default is a module `Worker` from a Trusted Types URL. */
  createWorker?: (url: string) => PdfWorker;
}

/** The FileRenderers for PDFs, with the end of their one shared pdf.js worker. */
export interface PdfRenderers extends FileRenderers {
  /** Terminates the worker (the board closed); later PDF blocks fail to load. */
  destroy(): void;
}

/** Larger PDFs are not rendered in the browser (the server caps uploads at 50 MB anyway). */
export const MAX_PDF_BYTES = 60 * 1_000_000;
/** Width of a rendered page in canvas pixels: sharp at 2x on a 600 px block, bounded memory. */
const RENDER_WIDTH = 1200;

/** The FileRenderers entry for PDFs, for `registerBuiltinBlocks`. */
export function pdfRenderers(options: PdfOptions): PdfRenderers {
  const load = options.load ?? defaultLoad;
  const fetchBytes = options.fetchBytes ?? defaultFetch;
  const createWorker = options.createWorker ?? defaultCreateWorker;
  let ready: Promise<PdfJs> | undefined;
  let worker: PdfWorker | undefined;
  let destroyed = false;
  const lib = (): Promise<PdfJs> => {
    ready ??= load().then((l) => {
      if (destroyed) {
        throw new Error('The PDF renderer is closed.');
      }
      worker = createWorker(`${options.assetBase}pdf.worker.min.mjs`);
      l.GlobalWorkerOptions.workerPort = worker;
      return l;
    });
    ready.catch(() => (ready = undefined)); // a failed chunk load is tried again next time
    return ready;
  };
  return {
    pdf: (host, file, links, ctx) =>
      new PdfView(host, file, links, ctx, options.assetBase, lib, fetchBytes),
    destroy() {
      destroyed = true;
      worker?.terminate();
      worker = undefined;
      void ready?.then(
        (l) => (l.GlobalWorkerOptions.workerPort = null),
        () => undefined,
      );
      ready = undefined;
    },
  };
}

function defaultCreateWorker(url: string): PdfWorker {
  // a Trusted Types policy exists only where the CSP asks for it; the policy refuses any URL
  // but the pdf.js worker file
  const script = scriptUrls?.createScriptURL(url) ?? url;
  return new Worker(script as string, { type: 'module' });
}

async function defaultLoad(): Promise<PdfJs> {
  return (await import('pdfjs-dist')) as unknown as PdfJs;
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  if (!response.ok) {
    throw new PdfFetchError(response.status);
  }
  const length = Number(response.headers.get('Content-Length'));
  if (length > MAX_PDF_BYTES) {
    throw new PdfFetchError(413);
  }
  return response.arrayBuffer();
}

/** A failed fetch: only the status, never the URL. */
export class PdfFetchError extends Error {
  constructor(readonly status: number) {
    super(`The PDF could not be fetched (HTTP ${status}).`);
    this.name = 'PdfFetchError';
  }
}

class PdfView implements FileContent {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly pager: HTMLElement;
  private readonly label: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private doc: PdfDocument | undefined;
  private task: PdfLoadingTask | undefined;
  private rendering: { cancel(): void } | undefined;
  private page = 1;
  private destroyed = false;
  private waitingForUrl = false;
  private retried = false;

  constructor(
    host: HTMLElement,
    private readonly file: FileMeta,
    links: FileLinks,
    private readonly ctx: FileContentContext,
    private readonly assetBase: string,
    private readonly lib: () => Promise<PdfJs>,
    private readonly fetchBytes: (url: string) => Promise<ArrayBuffer>,
  ) {
    const d = host.ownerDocument;
    this.root = d.createElement('div');
    this.root.className = 'be-pdf';
    this.root.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:var(--be-pdf-bg,#f1f5f9)';
    this.canvas = d.createElement('canvas');
    this.canvas.className = 'be-pdf-page';
    this.canvas.style.cssText =
      'max-width:100%;max-height:100%;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.2);display:none';
    this.status = d.createElement('div');
    this.status.className = 'be-pdf-status';
    this.status.style.cssText = 'padding:12px;text-align:center;color:var(--be-text-3,#64748b)';
    this.status.textContent = 'Loading PDF…';
    this.pager = d.createElement('div');
    this.pager.className = 'be-pdf-pager';
    this.pager.style.cssText =
      'position:absolute;bottom:6px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:4px;' +
      'background:rgba(15,23,42,.75);color:#fff;border-radius:999px;padding:2px 6px';
    this.prev = this.button('‹', 'Previous page', () => this.go(this.page - 1));
    this.next = this.button('›', 'Next page', () => this.go(this.page + 1));
    this.label = d.createElement('span');
    this.label.className = 'be-pdf-label';
    this.label.style.cssText = 'font-variant-numeric:tabular-nums;min-width:48px;text-align:center';
    this.pager.append(this.prev, this.label, this.next);
    this.root.append(this.canvas, this.status, this.pager);
    host.replaceChildren(this.root);
    void this.open(links);
  }

  update(_file: FileMeta, links: FileLinks): void {
    // the document is in memory once loaded; new URLs matter only after a failed fetch
    if (this.waitingForUrl) {
      this.waitingForUrl = false;
      void this.open(links);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.rendering?.cancel();
    void this.task?.destroy();
    void this.doc?.destroy();
    this.root.remove();
  }

  private async open(links: FileLinks): Promise<void> {
    this.show('Loading PDF…');
    try {
      const [lib, data] = await Promise.all([
        this.lib(),
        this.fetchBytes(links.pdfUrl ?? links.url),
      ]);
      if (this.destroyed) {
        return;
      }
      this.task = lib.getDocument({
        data,
        enableXfa: false,
        disableWorkerRendering: true,
        useSystemFonts: false,
        stopAtErrors: false,
        verbosity: 0,
        isOffscreenCanvasSupported: false,
        cMapUrl: `${this.assetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${this.assetBase}standard_fonts/`,
        wasmUrl: `${this.assetBase}wasm/`,
        iccUrl: `${this.assetBase}iccs/`,
      });
      // a password-protected PDF is not unlocked on the board
      this.task.onPassword = () => {
        void this.task?.destroy();
        this.show('This PDF is protected by a password. Download it to open it.');
      };
      this.doc = await this.task.promise;
      if (this.destroyed) {
        void this.doc.destroy();
        return;
      }
      await this.go(1);
    } catch (error) {
      if (this.destroyed) {
        return;
      }
      if (error instanceof PdfFetchError && error.status === 403 && !this.retried) {
        // the signed URL expired: one retry with new URLs
        this.retried = true;
        this.waitingForUrl = true;
        this.ctx.source.refresh(this.ctx.fileId);
        return;
      }
      if (!this.status.textContent?.includes('password')) {
        this.show('The PDF cannot be shown here. Download it to open it.');
      }
    }
  }

  private async go(page: number): Promise<void> {
    const doc = this.doc;
    if (!doc || page < 1 || page > doc.numPages) {
      return;
    }
    this.page = page;
    this.rendering?.cancel();
    this.updatePager(doc.numPages);
    const lib = await this.lib();
    const p = await doc.getPage(page);
    const natural = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: RENDER_WIDTH / Math.max(1, natural.width) });
    this.canvas.width = Math.round(viewport.width);
    this.canvas.height = Math.round(viewport.height);
    const task = p.render({
      canvas: this.canvas,
      viewport,
      annotationMode: lib.AnnotationMode.DISABLE,
    });
    this.rendering = task;
    try {
      await task.promise;
      this.canvas.style.display = 'block';
      this.status.style.display = 'none';
    } catch {
      // cancelled by a newer page or by destroy
    } finally {
      p.cleanup();
    }
  }

  private updatePager(pages: number): void {
    this.pager.style.display = pages > 1 ? 'flex' : 'none';
    this.label.textContent = `${this.page} / ${pages}`;
    this.prev.disabled = this.page <= 1;
    this.next.disabled = this.page >= pages;
  }

  private show(text: string): void {
    this.canvas.style.display = 'none';
    this.status.style.display = 'block';
    this.status.textContent = text;
  }

  private button(text: string, label: string, action: () => void): HTMLButtonElement {
    const b = this.root.ownerDocument.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', `${label} of ${this.file.name}`);
    b.setAttribute(INTERACTIVE_ATTR, '');
    b.style.cssText =
      'border:0;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    return b;
  }
}
