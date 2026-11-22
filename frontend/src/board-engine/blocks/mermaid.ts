import { MAX_MERMAID_BYTES, MERMAID_TYPE, BlockData, BoardTheme } from '@apps/drawboard-engine';
import { BlockType, BlockView } from '../renderer/block-registry';

/** Wait this long after the last keystroke before rendering again. */
export const RENDER_DELAY_MS = 250;

/** What a new diagram starts with. */
export const SAMPLE_DIAGRAM = 'flowchart LR\n  Idea --> Plan --> Build --> Ship';

/**
 * Turns diagram source into DOM nodes that are safe to insert (the host's sanitising Mermaid
 * renderer, S5.1). Rejects with an Error whose message is shown to the user as text.
 */
export interface DiagramRenderer {
  /** `theme` picks Mermaid's own light or dark theme (default light). */
  render(source: string, theme?: BoardTheme): Promise<Node>;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * `core.mermaid`: a diagram written in Mermaid syntax (architecture 3.7). The source lives in
 * the block's Y.Text (collaborative editing in the side panel); the view renders it through the
 * injected renderer, asynchronously and debounced, so typing and the board never wait for it.
 * Errors and oversized sources are shown as plain text. Without a renderer the source is shown.
 */
export function createMermaidBlock(renderer?: DiagramRenderer): BlockType {
  return {
    type: MERMAID_TYPE,
    label: 'Diagram',
    defaultSize: { w: 420, h: 260 },
    defaultProps: {},
    opensEditor: true,
    render(host, ctx) {
      return new MermaidView(host, ctx.block, ctx.text, renderer, ctx.theme);
    },
  };
}

class MermaidView implements BlockView {
  private readonly box: HTMLElement;
  private source: string | undefined;
  private shownTheme: BoardTheme | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private destroyed = false;

  constructor(
    host: HTMLElement,
    block: BlockData,
    private readonly text: () => string,
    private readonly renderer: DiagramRenderer | undefined,
    private readonly theme: () => BoardTheme,
  ) {
    this.box = host.ownerDocument.createElement('div');
    this.box.className = 'be-mermaid';
    this.box.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;' +
      'overflow:hidden;background:var(--be-surface,#fff);border:1px solid var(--be-border-soft,#e2e8f0);border-radius:6px;padding:8px;' +
      'font:12px system-ui,sans-serif;color:var(--be-text-strong,#334155)';
    host.appendChild(this.box);
    this.refresh(block, true);
  }

  update(block: BlockData): void {
    this.refresh(block, false);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.box.remove();
  }

  private refresh(_block: BlockData, first: boolean): void {
    const source = this.text();
    const theme = this.theme();
    // a theme change draws the same source again, in Mermaid's theme of the new colour scheme
    if (source === this.source && theme === this.shownTheme) {
      return;
    }
    this.source = source;
    this.shownTheme = theme;
    clearTimeout(this.timer);
    if (source.trim() === '') {
      this.message('Empty diagram. Double-click to write it.');
      return;
    }
    if (byteLength(source) > MAX_MERMAID_BYTES) {
      this.message('The diagram source is larger than 50 KB and is not rendered.');
      return;
    }
    if (!this.renderer) {
      this.showSource(source);
      return;
    }
    if (first) {
      this.message('Rendering diagram…');
    }
    // off the main path: never inside the transaction that changed the text
    this.timer = setTimeout(() => void this.render(source, theme), first ? 0 : RENDER_DELAY_MS);
  }

  private async render(source: string, theme: BoardTheme): Promise<void> {
    const generation = ++this.generation;
    try {
      const node = await (this.renderer as DiagramRenderer).render(source, theme);
      if (!this.destroyed && generation === this.generation) {
        this.box.replaceChildren(this.diagram(node));
      }
    } catch (error) {
      if (!this.destroyed && generation === this.generation) {
        const text = error instanceof Error ? error.message : String(error);
        this.message(`Diagram error: ${text.slice(0, 500)}`, true);
      }
    }
  }

  /**
   * The sanitised SVG goes into a shadow root of its own element, so an inline `<style>` of the
   * diagram is scoped to it and cannot restyle the board (review finding 5).
   */
  private diagram(node: Node): HTMLElement {
    const holder = this.box.ownerDocument.createElement('div');
    holder.className = 'be-mermaid-diagram';
    holder.style.cssText =
      'width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden';
    holder.attachShadow({ mode: 'open' }).replaceChildren(node);
    return holder;
  }

  private message(text: string, error = false): void {
    const p = this.box.ownerDocument.createElement('div');
    p.className = error ? 'be-mermaid-error' : 'be-mermaid-message';
    p.style.cssText = `white-space:pre-wrap;text-align:center;color:${error ? 'var(--be-danger,#b91c1c)' : 'var(--be-text-3,#64748b)'}`;
    p.textContent = text;
    this.box.replaceChildren(p);
  }

  private showSource(source: string): void {
    const pre = this.box.ownerDocument.createElement('pre');
    pre.className = 'be-mermaid-source';
    pre.style.cssText =
      'margin:0;white-space:pre-wrap;font:11px ui-monospace,monospace;align-self:flex-start';
    pre.textContent = source;
    this.box.replaceChildren(pre);
  }
}
