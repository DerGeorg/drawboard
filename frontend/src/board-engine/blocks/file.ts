import { FileLinks, FileMeta, FileSource, FileState } from '../files/file-source';
import { BlockData } from '../model/types';
import { BlockType, BlockView } from '../renderer/block-registry';

export const FILE_TYPE = 'core.file';

/** Marks elements inside a block that take their own pointer input (buttons, video controls). */
export const INTERACTIVE_ATTR = 'data-be-interactive';

/** Office originals may contain macros: said next to every download of one (S4.11). */
export const MACRO_HINT = 'Office files may contain macros. Open the original with care.';

/** Largest edge of a new image or video block in board units. */
const MAX_EDGE = 480;

/** Height of the caption bar (file name and download button) under the content. */
export const CAPTION_HEIGHT = 28;

/** The file a block shows; the Y.Doc stores nothing else about it (S4.4: no URL, ever). */
export function fileIdOf(block: BlockData): string | undefined {
  const id = block.props['fileId'];
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : undefined;
}

/** Size of a new block for a file: images and videos keep their aspect ratio. */
export function fileBlockSize(file: Pick<FileMeta, 'kind' | 'width' | 'height'>): {
  w: number;
  h: number;
} {
  if ((file.kind === 'IMAGE' || file.kind === 'VIDEO') && file.width && file.height) {
    const scale = Math.min(1, MAX_EDGE / Math.max(file.width, file.height));
    return {
      w: Math.max(48, Math.round(file.width * scale)),
      h: Math.max(48, Math.round(file.height * scale)) + CAPTION_HEIGHT,
    };
  }
  switch (file.kind) {
    case 'VIDEO':
      return { w: 480, h: 270 + CAPTION_HEIGHT };
    case 'PDF':
    case 'DOCUMENT':
      return { w: 360, h: 480 };
    default:
      return { w: 320, h: 200 };
  }
}

/** Something a file view can show in its content area: an image, a video, a card, a PDF. */
export interface FileContent {
  /** New URLs or metadata arrived (renewal, conversion). Most views keep what they loaded. */
  update(file: FileMeta, links: FileLinks): void;
  destroy(): void;
}

/**
 * Optional renderers the host can plug in for kinds the files block does not render itself
 * (PDF via pdf.js lives in its own lazy chunk).
 */
export interface FileRenderers {
  /** Renders a PDF (also a converted document) into `host`; absent = a download card. */
  pdf?(host: HTMLElement, file: FileMeta, links: FileLinks, ctx: FileContentContext): FileContent;
}

export interface FileContentContext {
  readonly source: FileSource;
  readonly fileId: string;
}

/**
 * `core.file`: an uploaded file on the board (architecture 3.6). Images and videos are shown
 * inline, PDFs and converted Office documents by the `pdf` renderer, everything else as a card
 * with a download button. Built-in (trusted): registered from the image like every core block.
 */
export function createFileBlock(source: FileSource, renderers: FileRenderers = {}): BlockType {
  return {
    type: FILE_TYPE,
    label: 'File',
    defaultSize: { w: 320, h: 200 },
    defaultProps: {},
    render(host, ctx) {
      return new FileView(host, ctx.block, source, renderers);
    },
  };
}

class FileView implements BlockView {
  private readonly doc: Document;
  private readonly box: HTMLElement;
  private readonly content: HTMLElement;
  private readonly caption: HTMLElement;
  private fileId: string | undefined;
  private unwatch: (() => void) | undefined;
  private current: FileContent | undefined;
  private currentKey = '';

  constructor(
    host: HTMLElement,
    block: BlockData,
    private readonly source: FileSource,
    private readonly renderers: FileRenderers,
  ) {
    this.doc = host.ownerDocument;
    this.box = this.el('div', 'be-file');
    this.box.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;' +
      'background:#fff;border:1px solid #e2e8f0;border-radius:6px;font:12px system-ui,sans-serif;color:#334155';
    this.content = this.el('div', 'be-file-content');
    this.content.style.cssText =
      'flex:1 1 auto;min-height:0;position:relative;display:flex;align-items:center;justify-content:center';
    this.caption = this.el('div', 'be-file-caption');
    this.caption.style.cssText =
      `flex:0 0 ${CAPTION_HEIGHT}px;display:flex;align-items:center;gap:6px;padding:0 6px;` +
      'border-top:1px solid #e2e8f0;background:#f8fafc';
    this.box.append(this.content, this.caption);
    host.appendChild(this.box);
    this.follow(fileIdOf(block));
  }

  update(block: BlockData): void {
    const id = fileIdOf(block);
    if (id !== this.fileId) {
      this.follow(id);
    }
  }

  destroy(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.clearContent();
    this.box.remove();
  }

  private follow(fileId: string | undefined): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.fileId = fileId;
    this.show({ status: fileId ? 'loading' : 'missing' });
    if (fileId) {
      this.unwatch = this.source.watch(fileId, (state) => this.show(state));
    }
  }

  private show(state: FileState): void {
    if (state.status !== 'ready') {
      this.clearContent();
      this.content.replaceChildren(this.message(MESSAGES[state.status]));
      this.setCaption(undefined);
      return;
    }
    const { file, links } = state;
    // the same kind of content stays and only learns about the new URLs (a playing video or a
    // loaded image must not restart every time the URLs are renewed)
    const key = `${file.kind}|${file.conversion}`;
    if (this.current && key === this.currentKey) {
      this.current.update(file, links);
    } else {
      this.clearContent();
      this.currentKey = key;
      this.current = this.createContent(file, links);
    }
    this.setCaption(file);
  }

  private createContent(file: FileMeta, links: FileLinks): FileContent {
    const ctx: FileContentContext = { source: this.source, fileId: file.id };
    if (file.kind === 'IMAGE') {
      return imageContent(this.content, file, links, ctx);
    }
    if (file.kind === 'VIDEO') {
      return videoContent(this.content, links, ctx);
    }
    const pdfReady =
      file.kind === 'PDF' || (file.kind === 'DOCUMENT' && file.conversion === 'DONE');
    if (pdfReady && this.renderers.pdf) {
      return this.renderers.pdf(this.content, file, links, ctx);
    }
    return cardContent(this.content, file);
  }

  private clearContent(): void {
    try {
      this.current?.destroy();
    } catch {
      // a renderer failing on destroy must not keep the old content
    }
    this.current = undefined;
    this.currentKey = '';
    this.content.replaceChildren();
  }

  private setCaption(file: FileMeta | undefined): void {
    if (!file) {
      this.caption.replaceChildren();
      this.caption.style.display = 'none';
      return;
    }
    this.caption.style.display = 'flex';
    const name = this.el('span', 'be-file-name');
    name.style.cssText =
      'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.textContent = file.name;
    name.title = file.name;
    const download = this.el('button', 'be-file-download');
    download.setAttribute('type', 'button');
    download.setAttribute(INTERACTIVE_ATTR, '');
    download.setAttribute('aria-label', `Download ${file.name}`);
    download.title = file.kind === 'DOCUMENT' ? `Download the original. ${MACRO_HINT}` : 'Download';
    download.textContent = '⤓'; // downwards arrow to bar
    download.style.cssText =
      'flex:0 0 auto;border:0;background:transparent;cursor:pointer;font-size:14px;line-height:1;padding:4px;color:#334155';
    download.addEventListener('click', (e) => {
      e.stopPropagation();
      this.source.download(file.id);
    });
    this.caption.replaceChildren(name, download);
  }

  private message(text: string): HTMLElement {
    const p = this.el('div', 'be-file-message');
    p.style.cssText = 'padding:12px;text-align:center;color:#64748b';
    p.textContent = text;
    return p;
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
    const e = this.doc.createElement(tag);
    e.className = cls;
    return e;
  }
}

const MESSAGES: Record<'loading' | 'missing' | 'error', string> = {
  loading: 'Loading file…',
  missing: 'This file is not available (it was removed or belongs to another board).',
  error: 'The file could not be loaded. Retrying…',
};

/** An image, as large as the block allows; thumbnails for small blocks. */
function imageContent(
  host: HTMLElement,
  file: FileMeta,
  links: FileLinks,
  ctx: FileContentContext,
): FileContent {
  const img = host.ownerDocument.createElement('img');
  img.className = 'be-file-image';
  img.alt = file.name;
  img.draggable = false;
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;pointer-events:none';
  let failed = false;
  img.addEventListener('error', () => {
    // the URL expired while the image was out of the cache: ask for new ones once
    if (!failed) {
      failed = true;
      ctx.source.refresh(ctx.fileId);
    }
  });
  img.src = links.url;
  host.replaceChildren(img);
  return {
    update(_file, next) {
      if (failed) {
        failed = false;
        img.src = next.url;
      }
    },
    destroy: () => img.remove(),
  };
}

/** A video with the browser's controls; ranges are fetched with the signed URL. */
function videoContent(host: HTMLElement, links: FileLinks, ctx: FileContentContext): FileContent {
  const video = host.ownerDocument.createElement('video');
  video.className = 'be-file-video';
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  video.setAttribute(INTERACTIVE_ATTR, '');
  video.style.cssText = 'width:100%;height:100%;background:#0f172a';
  let failedAt: number | undefined;
  video.addEventListener('error', () => {
    // a range request after the URL expired: continue at the same position with a new URL
    if (failedAt === undefined) {
      failedAt = video.currentTime || 0;
      ctx.source.refresh(ctx.fileId);
    }
  });
  video.src = links.url;
  host.replaceChildren(video);
  return {
    update(_file, next) {
      if (failedAt !== undefined) {
        const at = failedAt;
        failedAt = undefined;
        video.src = next.url;
        video.currentTime = at;
      }
    },
    destroy: () => {
      video.pause?.();
      video.removeAttribute('src');
      video.remove();
    },
  };
}

const KIND_LABEL: Record<string, string> = {
  IMAGE: 'Image',
  VIDEO: 'Video',
  PDF: 'PDF',
  DOCUMENT: 'Document',
};

/** The generic file card: kind, size, conversion state; download in the caption. */
export function cardContent(host: HTMLElement, file: FileMeta): FileContent {
  const doc = host.ownerDocument;
  const card = doc.createElement('div');
  card.className = 'be-file-card';
  card.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px;text-align:center';
  const kind = doc.createElement('div');
  kind.className = 'be-file-kind';
  kind.style.cssText = 'font-weight:600;font-size:14px';
  const detail = doc.createElement('div');
  detail.className = 'be-file-detail';
  const status = doc.createElement('div');
  status.className = 'be-file-status';
  status.style.color = '#64748b';
  card.append(kind, detail, status);
  const apply = (f: FileMeta): void => {
    kind.textContent = KIND_LABEL[f.kind] ?? 'File';
    const pages = f.pageCount ? ` · ${f.pageCount} ${f.pageCount === 1 ? 'page' : 'pages'}` : '';
    detail.textContent = `${formatSize(f.size)}${pages}`;
    status.textContent = statusText(f);
  };
  apply(file);
  host.replaceChildren(card);
  return { update: (f) => apply(f), destroy: () => card.remove() };
}

function statusText(file: FileMeta): string {
  if (file.kind !== 'DOCUMENT') {
    return '';
  }
  switch (file.conversion) {
    case 'PENDING':
      return 'Converting to PDF…';
    case 'FAILED':
      return `No preview: the conversion failed. ${MACRO_HINT}`;
    default:
      return MACRO_HINT;
  }
}

/** "512 B", "3.4 kB", "12 MB" (the engine has no Angular pipe). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
