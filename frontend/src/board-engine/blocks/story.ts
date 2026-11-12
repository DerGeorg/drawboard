import { BlockRenderContext, BlockType, BlockView } from '../renderer/block-registry';
import { renderSafeText } from '../util/safe-text';
import { STORY_TYPE, StoryState, readStory } from './story-model';

/** The request the "estimating" chip of a story card sends: open the planning poker dialog. */
export const STORY_ESTIMATE_ACTION = 'story.estimate';

/**
 * Which story cards have an open planning poker round, as the SERVER pairs them
 * (`round.storyBlockId`, from listPokerRounds) - never from the card's own `pokerRoundId`, which
 * any editor can write (M4 contract review).
 */
export interface EstimateSource {
  isOpen(blockId: string): boolean;
  /** Called when the set of open rounds changed; returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/**
 * `core.story` (architecture 3.10): a scrum story card with title, description, acceptance
 * criteria and the agreed estimate. Shown on the canvas; edited in the app's side panel
 * (double-click or Enter: `opensEditor`). Built-in and trusted: it reads its own props through
 * `ctx.host`; text goes through `renderSafeText` only (S5.2).
 */
export function createStoryBlock(estimates?: EstimateSource): BlockType {
  return {
    type: STORY_TYPE,
    label: 'Story card',
    defaultSize: { w: 300, h: 220 },
    defaultProps: {},
    opensEditor: true,
    render(host, ctx) {
      return new StoryView(host, ctx, estimates);
    },
  };
}

/** What a screen reader says for a story card. */
export function storyLabel(story: StoryState): string {
  const done = story.criteria.filter((c) => c.done).length;
  return [
    `Story: ${story.title || 'Untitled story'}`,
    story.estimate === null ? 'not estimated' : `estimate ${story.estimate}`,
    story.criteria.length > 0
      ? `${done} of ${story.criteria.length} acceptance criteria done`
      : 'no acceptance criteria',
  ].join(', ');
}

class StoryView implements BlockView {
  private readonly card: HTMLElement;
  private readonly title: HTMLElement;
  private readonly estimate: HTMLElement;
  private readonly description: HTMLElement;
  private readonly criteria: HTMLElement;
  private readonly chip: HTMLButtonElement;
  private readonly offEstimates: () => void;

  constructor(
    host: HTMLElement,
    private readonly ctx: BlockRenderContext,
    private readonly estimates: EstimateSource | undefined,
  ) {
    const doc = host.ownerDocument;
    const el = (tag: string, className: string, css: string): HTMLElement => {
      const e = doc.createElement(tag);
      e.className = className;
      e.style.cssText = css;
      return e;
    };
    this.card = el(
      'article',
      'be-story',
      'width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;' +
        'padding:10px 12px 10px 16px;background:#fff;border:1px solid #cbd5e1;border-left:6px solid #0d9488;' +
        'border-radius:6px;overflow:hidden;font:13px/1.35 system-ui,sans-serif;color:#1f2937;' +
        'box-shadow:0 1px 2px rgba(15,23,42,.12)',
    );
    const head = el('div', 'be-story-head', 'display:flex;align-items:center;gap:8px');
    const kind = el(
      'span',
      'be-story-kind',
      'font-size:10px;font-weight:700;letter-spacing:.08em;color:#0f766e;text-transform:uppercase',
    );
    kind.textContent = 'Story';
    kind.setAttribute('aria-hidden', 'true');
    this.estimate = el(
      'span',
      'be-story-estimate',
      'margin-left:auto;min-width:22px;text-align:center;padding:1px 7px;border-radius:10px;' +
        'background:#ccfbf1;color:#134e4a;font-weight:700',
    );
    this.chip = el(
      'button',
      'be-story-poker',
      'border:0;border-radius:10px;padding:1px 8px;background:#0d9488;color:#fff;font:600 11px system-ui,sans-serif;cursor:pointer',
    ) as HTMLButtonElement;
    this.chip.type = 'button';
    this.chip.textContent = 'Estimating';
    this.chip.title = 'A planning poker round is open: estimate this story';
    this.chip.setAttribute('aria-label', 'Open the planning poker round of this story');
    this.chip.setAttribute('data-be-interactive', '');
    this.chip.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.chip.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.host?.request({ blockId: ctx.block.id, action: STORY_ESTIMATE_ACTION });
    });
    head.append(kind, this.chip, this.estimate);
    this.title = el(
      'div',
      'be-story-title',
      'font-weight:600;font-size:15px;overflow-wrap:anywhere;white-space:pre-wrap',
    );
    this.description = el(
      'div',
      'be-story-description',
      'color:#475569;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;' +
        'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3',
    );
    this.criteria = el(
      'ul',
      'be-story-criteria',
      'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:12px',
    );
    this.card.append(head, this.title, this.description, this.criteria);
    host.appendChild(this.card);
    this.offEstimates = estimates?.onChange(() => this.update()) ?? (() => undefined);
    this.update();
  }

  update(): void {
    const board = this.ctx.host?.board;
    const story: StoryState = board
      ? readStory(board, this.ctx.block.id)
      : {
          title: this.ctx.text(),
          description: '',
          criteria: [],
          estimate: null,
          pokerRoundId: null,
        };
    this.card.setAttribute('aria-label', storyLabel(story));
    this.chip.style.display = this.estimates?.isOpen(this.ctx.block.id) ? '' : 'none';
    this.estimate.textContent = story.estimate ?? '–';
    this.estimate.title = story.estimate === null ? 'Not estimated' : `Estimate: ${story.estimate}`;
    renderSafeText(this.title, story.title || 'Untitled story');
    renderSafeText(this.description, story.description);
    this.description.style.display = story.description ? '-webkit-box' : 'none';
    const doc = this.criteria.ownerDocument;
    this.criteria.replaceChildren(
      ...story.criteria.map((c) => {
        const li = doc.createElement('li');
        li.className = 'be-story-criterion';
        li.dataset['done'] = String(c.done);
        li.style.cssText = `display:flex;gap:6px;${c.done ? 'color:#64748b;text-decoration:line-through' : ''}`;
        const box = doc.createElement('span');
        box.setAttribute('aria-hidden', 'true');
        box.textContent = c.done ? '☑' : '☐';
        const text = doc.createElement('span');
        text.style.cssText = 'overflow-wrap:anywhere';
        text.textContent = c.text;
        li.append(box, text);
        return li;
      }),
    );
  }

  destroy(): void {
    this.offEstimates();
    this.card.remove();
  }
}
