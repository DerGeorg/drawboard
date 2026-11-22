import { GifConsent } from '../gifs/gif-consent';
import { GifSlots } from '../gifs/gif-slots';
import {
  GIF_INVALID_ID,
  GIF_SMALL_MAX_WIDTH,
  gifUrl,
  isValidGifAlt,
  GIF_DEFAULT_SIZE,
  GIF_TYPE,
  BlockData,
} from '@apps/drawboard-engine';
import { BlockType, BlockView } from '../renderer/block-registry';

/** Marks elements inside a block that take their own pointer input (see blocks/file.ts). */
const INTERACTIVE = 'data-be-interactive';

/**
 * What the GIF block needs from the host (architecture 3.14). Without it the block behaves like
 * an instance without GIFs: a placeholder, nothing is ever loaded.
 */
export interface GifServices {
  /** `gifsEnabled` of /config.json: the instance's CSP allows GIPHY images (G3). */
  readonly enabled: boolean;
  /**
   * `never`: this view shows a labelled box and loads nothing, with or without consent - /open
   * data links (S5.6), exports and thumbnails (G11). Default `live`.
   */
  readonly mode?: 'live' | 'never';
  /** The viewer's consent (G10); without it nothing loads. */
  readonly consent?: GifConsent;
  /** The key the "Load" consent is given for: the board's id. */
  readonly boardKey?: () => string;
  /** The room for loaded images, one per engine; default 30 (G9). */
  readonly slots?: GifSlots;
}

export const CONSENT_TEXT = 'GIF from GIPHY – loading it sends your IP address to GIPHY';
export const DISABLED_TEXT = 'GIF – GIPHY is not enabled on this instance';
export const NEVER_TEXT = 'GIF from GIPHY – not loaded in this view';
export const INVALID_TEXT = 'GIF – not available';
export const FAILED_TEXT = 'GIF could not be loaded from GIPHY';
export const WAITING_TEXT = 'GIF from GIPHY – too many GIFs are shown at once';

/**
 * `core.gif`: one GIF from GIPHY, props `{ giphyId, alt? }` and nothing else (G9). The image is
 * loaded by the viewer's browser straight from GIPHY from a URL made of constants and the
 * validated id (`gifUrl`), only after that viewer agreed (G10), only while the block is in the
 * viewport, and with at most 30 images at a time. No copy lives on the server (G13). Built-in
 * and trusted (G14).
 */
export function createGifBlock(services: GifServices = { enabled: false }): BlockType {
  // one limit per engine: the blocks of one board share it
  const slots = services.slots ?? new GifSlots();
  return {
    type: GIF_TYPE,
    label: 'GIF',
    defaultSize: GIF_DEFAULT_SIZE,
    defaultProps: { giphyId: GIF_INVALID_ID },
    // far out the GIF is a flat, quiet box (the image would be a few pixels anyway)
    simpleFill: () => '#c4b5fd',
    render(host, ctx) {
      return new GifView(host, ctx.block, { ...services, slots });
    },
  };
}

type State = 'invalid' | 'never' | 'disabled' | 'consent' | 'idle' | 'waiting' | 'failed' | 'live';

class GifView implements BlockView {
  private readonly doc: Document;
  private readonly box: HTMLElement;
  private readonly slots: GifSlots;
  private block: BlockData;
  private state: State | undefined;
  private shownKey: string | undefined;
  // without an observer (old browsers, tests) the renderer's culling is all there is; with one,
  // nothing loads before its first report says the block is in the viewport (G9)
  private visible = typeof IntersectionObserver === 'undefined';
  private img: HTMLImageElement | undefined;
  private imgUrl: string | undefined;
  private failedUrl: string | undefined;
  private release: (() => void) | undefined;
  private observer: IntersectionObserver | undefined;
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly host: HTMLElement,
    block: BlockData,
    private readonly services: GifServices & { slots: GifSlots },
  ) {
    this.doc = host.ownerDocument;
    this.block = block;
    this.slots = services.slots;
    this.box = this.doc.createElement('div');
    this.box.className = 'be-gif';
    this.box.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;overflow:hidden;position:relative;' +
      'display:flex;align-items:center;justify-content:center;border-radius:6px;' +
      'background:var(--be-surface-2,#f8fafc);border:1px solid var(--be-border-soft,#e2e8f0);' +
      'color:var(--be-text-strong,#334155);font:11px/1.3 system-ui,sans-serif;text-align:center';
    host.appendChild(this.box);
    // one viewer decision applies to every GIF of the board; a freed slot wakes a waiting one
    if (services.consent) {
      this.off.push(services.consent.changed.on(() => this.refresh()));
    }
    this.off.push(
      this.slots.freed.on(() => {
        if (this.state === 'waiting') {
          this.refresh();
        }
      }),
    );
    this.refresh();
  }

  mounted(): void {
    // only what is in the viewport loads (G9); without the observer (old browsers, tests) the
    // renderer's own culling around the viewport is what is left
    if (typeof IntersectionObserver === 'undefined' || this.observer) {
      return;
    }
    this.observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last && last.isIntersecting !== this.visible) {
        this.visible = last.isIntersecting;
        this.refresh();
      }
    });
    this.observer.observe(this.host);
  }

  update(block: BlockData): void {
    this.block = block;
    this.refresh();
  }

  destroy(): void {
    this.off.forEach((o) => o());
    this.off.length = 0;
    this.observer?.disconnect();
    this.observer = undefined;
    this.dropImage();
    this.box.remove();
  }

  private size(): 'small' | 'original' {
    return this.block.w > GIF_SMALL_MAX_WIDTH ? 'original' : 'small';
  }

  /** The alt text, only if it passes the rule of the block (a peer can write anything). */
  private alt(): string {
    const alt = this.block.props['alt'];
    return isValidGifAlt(alt) ? alt : '';
  }

  private decide(url: string | undefined): State {
    if (!url) {
      return 'invalid';
    }
    if (this.services.mode === 'never') {
      return 'never';
    }
    if (!this.services.enabled) {
      return 'disabled';
    }
    const { consent, boardKey } = this.services;
    if (!consent || !boardKey || !consent.allowed(boardKey())) {
      return 'consent';
    }
    if (this.failedUrl === url) {
      return 'failed';
    }
    return this.visible ? 'live' : 'idle';
  }

  private refresh(): void {
    // every read validates again before a URL exists (G9)
    const url = gifUrl(this.block.props['giphyId'], this.size());
    let state = this.decide(url);
    if (state === 'live' && url) {
      if (this.img && this.imgUrl === url) {
        this.img.alt = this.alt();
        this.state = 'live';
        this.shownKey = undefined;
        return;
      }
      this.dropImage();
      this.release = this.slots.acquire();
      if (!this.release) {
        state = 'waiting';
      } else {
        this.showImage(url);
        this.state = 'live';
        this.shownKey = undefined;
        return;
      }
    }
    this.dropImage();
    // the same placeholder (and alt line) stays as it is: buttons keep their focus
    const key = `${state}|${this.alt()}`;
    if (key === this.shownKey) {
      return;
    }
    this.shownKey = key;
    this.state = state;
    this.box.replaceChildren(...this.placeholder(state));
  }

  private showImage(url: string): void {
    const img = this.doc.createElement('img');
    img.className = 'be-gif-image';
    img.alt = this.alt();
    img.draggable = false;
    // attributes, not properties: what is written here is what the browser reads
    img.setAttribute('crossorigin', 'anonymous');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;pointer-events:none';
    img.addEventListener('error', () => {
      // GIPHY removed it, is not reachable, or the CSP refused: say so, never retry in a loop
      this.failedUrl = url;
      this.refresh();
    });
    this.imgUrl = url;
    this.img = img;
    this.box.replaceChildren(img, this.label('GIPHY', true));
    // the one place a GIF source is set; `url` came out of gifUrl (constants and a valid id)
    img.src = url;
  }

  private dropImage(): void {
    if (this.img) {
      // cancels a running download and frees the decoded frames
      this.img.removeAttribute('src');
      this.img.remove();
    }
    this.img = undefined;
    this.imgUrl = undefined;
    this.release?.();
    this.release = undefined;
  }

  private placeholder(state: State): Node[] {
    const text = (s: string): HTMLElement => this.text(s);
    switch (state) {
      case 'consent':
        return [this.consentView()];
      case 'disabled':
        return [this.stack(this.label('GIPHY'), text(DISABLED_TEXT))];
      case 'never':
        return [this.stack(this.label('GIPHY'), text(NEVER_TEXT), ...this.altLine())];
      case 'failed':
        return [this.stack(this.label('GIPHY'), text(FAILED_TEXT), ...this.altLine())];
      case 'waiting':
        return [this.stack(this.label('GIPHY'), text(WAITING_TEXT))];
      case 'idle':
        return [this.stack(this.label('GIPHY'))];
      default:
        return [this.stack(text(INVALID_TEXT))];
    }
  }

  private consentView(): HTMLElement {
    const { consent, boardKey } = this.services;
    const load = this.button('Load', 'Load GIFs on this board (until you close the tab)', () =>
      consent?.allowBoard(boardKey?.() ?? ''),
    );
    const always = this.button(
      'Always in this browser',
      'Load GIFs without asking again in this browser',
      () => consent?.allowAlways(),
    );
    const buttons = this.doc.createElement('div');
    buttons.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;justify-content:center';
    buttons.append(load, always);
    return this.stack(this.label('GIPHY'), this.text(CONSENT_TEXT), ...this.altLine(), buttons);
  }

  private altLine(): HTMLElement[] {
    const alt = this.alt();
    if (!alt) {
      return [];
    }
    const line = this.text(alt);
    line.style.fontStyle = 'italic';
    line.style.opacity = '0.8';
    return [line];
  }

  private stack(...children: Node[]): HTMLElement {
    const el = this.doc.createElement('div');
    el.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;max-width:100%;max-height:100%;overflow:hidden';
    el.append(...children);
    return el;
  }

  private text(content: string): HTMLElement {
    const p = this.doc.createElement('div');
    p.textContent = content;
    return p;
  }

  /** "GIPHY" as text (G15): a corner mark on the image, a heading on a placeholder. */
  private label(content: string, corner = false): HTMLElement {
    const el = this.text(content);
    el.className = 'be-gif-label';
    el.style.cssText = corner
      ? 'position:absolute;right:4px;bottom:4px;padding:0 4px;border-radius:3px;font-size:9px;font-weight:700;' +
        'background:rgba(15,23,42,0.6);color:#fff;pointer-events:none'
      : 'font-weight:700;letter-spacing:0.04em;font-size:10px;color:var(--be-text-3,#64748b)';
    return el;
  }

  private button(label: string, title: string, onClick: () => void): HTMLElement {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute(INTERACTIVE, '');
    b.style.cssText =
      'border:1px solid var(--be-border,#cbd5e1);background:var(--be-chip,#e2e8f0);color:var(--be-text-strong,#334155);' +
      'border-radius:4px;padding:2px 6px;font:inherit;cursor:pointer';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }
}
