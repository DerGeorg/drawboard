import { NewBlock } from '../model/board-doc';
import { Point } from '../model/types';
import { BlockHost, BlockRenderContext, BlockType, BlockView } from '../renderer/block-registry';
import {
  KANBAN_LIMITS,
  KANBAN_TYPE,
  KanbanCard,
  KanbanLabel,
  KanbanModel,
  KanbanState,
  labelColor,
} from './kanban-model';
import { STICKY_COLORS, STICKY_TYPE } from './sticky';

/** Pointer travel (CSS px) before a press on a card becomes a drag. */
export const DRAG_THRESHOLD = 4;

/** The request a click (or Enter) on a card sends to the host app: open the card editor. */
export const KANBAN_CARD_ACTION = 'kanban.card';

export const LABEL_NAMES: Readonly<Record<KanbanLabel, string>> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  grey: 'Grey',
};

/**
 * What a card becomes when it is dragged out of the kanban onto the canvas. The default is a
 * sticky note with the card's title; `alternative` is the variant for a drop with Shift held
 * (a story card once that type exists). Returns the new block centred on `at`.
 */
export interface CardOut {
  sticky(card: KanbanCard, at: Point): NewBlock;
  alternative?(card: KanbanCard, at: Point): NewBlock;
}

export const STICKY_OUT: CardOut = {
  sticky: (card, at) => ({
    type: STICKY_TYPE,
    x: at.x - 100,
    y: at.y - 100,
    w: 200,
    h: 200,
    props: { color: STICKY_COLORS[0] },
    text: card.title,
  }),
};

/**
 * `core.kanban` (architecture 3.10): columns of cards with title, assignee, due date, labels and
 * story points, edited in place. Built-in and trusted: it edits its own props through
 * `ctx.host` (KanbanModel); without a host or on a read-only board it only shows them.
 *
 * Mouse: drag a card into another column or position; drop it outside the kanban to turn it
 * into a sticky note on the canvas (Shift: the alternative, see `CardOut`). Keyboard on a
 * focused card: Enter opens it, Delete removes it, arrows move the focus, Alt+arrows move the
 * card. The card editor itself belongs to the host app (`kanban.card` request).
 */
export function createKanbanBlock(out: CardOut = STICKY_OUT): BlockType {
  return {
    type: KANBAN_TYPE,
    label: 'Kanban',
    defaultSize: { w: 760, h: 440 },
    defaultProps: {},
    render(host, ctx) {
      return new KanbanView(host, ctx, out);
    },
  };
}

type Editor =
  | { kind: 'title'; value: string }
  | { kind: 'column'; id: string; value: string }
  | { kind: 'new-card'; id: string; value: string }
  | { kind: 'new-column'; value: string };

interface Drag {
  readonly cardId: string;
  readonly pointerId: number;
  readonly start: Point;
  active: boolean;
  ghost?: HTMLElement;
  marker?: HTMLElement;
  target?: { columnId: string; index: number } | 'out';
}

const STYLE_ID = 'be-kanban-style';

const KANBAN_CSS = `
.be-kanban button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;border-radius:4px;padding:2px 6px}
.be-kanban button:hover:not(:disabled){background:rgba(15,23,42,.08)}
.be-kanban button:disabled{opacity:.35;cursor:default}
.be-kanban button:focus-visible,.be-kb-card:focus-visible{outline:2px solid #2563eb;outline-offset:1px}
.be-kb-card{cursor:grab}
.be-kb-col-tools{display:flex;gap:1px;opacity:.55}
.be-kb-col:hover .be-kb-col-tools,.be-kb-col:focus-within .be-kb-col-tools{opacity:1}
`;

/** One style sheet per document for the hover/focus rules inline styles cannot express. */
function ensureStyles(doc: Document): void {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = KANBAN_CSS;
    doc.head.appendChild(style);
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/** Today as `YYYY-MM-DD` in the viewer's zone (due dates are days, not instants). */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDue(due: string): string {
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** What a screen reader says for a card. */
export function cardLabel(card: KanbanCard): string {
  const parts = [card.title || 'Untitled card'];
  if (card.assignee) {
    parts.push(`assigned to ${card.assignee}`);
  }
  if (card.due) {
    parts.push(`due ${card.due}`);
  }
  if (card.points !== null) {
    parts.push(`${card.points} points`);
  }
  if (card.labels.length > 0) {
    parts.push(`labels ${card.labels.map((l) => LABEL_NAMES[l]).join(', ')}`);
  }
  return parts.join(', ');
}

class KanbanView implements BlockView {
  private readonly doc: Document;
  private readonly root: HTMLElement;
  private readonly model: KanbanModel | undefined;
  private readonly host: BlockHost | undefined;
  private readonly offMode: () => void;
  private state: KanbanState = { title: '', columns: [] };
  private editor: Editor | undefined;
  private drag: Drag | undefined;
  /** A card to focus after the next render (it was moved or the focus was on it). */
  private focusCard: string | undefined;
  private pendingRender = false;

  constructor(
    host: HTMLElement,
    private readonly ctx: BlockRenderContext,
    private readonly out: CardOut,
  ) {
    this.doc = host.ownerDocument;
    ensureStyles(this.doc);
    this.host = ctx.host;
    this.model = ctx.host
      ? new KanbanModel(ctx.host.board, ctx.block.id, () => ctx.host?.stopCapturing())
      : undefined;
    this.root = this.doc.createElement('div');
    this.root.className = 'be-kanban';
    this.root.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;' +
      'background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;' +
      'font:13px/1.35 system-ui,sans-serif;color:#1f2937';
    host.appendChild(this.root);
    this.offMode = ctx.host?.onReadOnlyChanged(() => this.render()) ?? (() => undefined);
    this.render();
  }

  update(): void {
    this.render();
  }

  destroy(): void {
    this.offMode();
    this.endDrag();
    this.root.remove();
  }

  private get editable(): boolean {
    return !!this.model && !!this.host && !this.host.readOnly() && !this.ctx.readOnly;
  }

  // ---- rendering -----------------------------------------------------------------------------

  private render(): void {
    if (this.drag?.active) {
      this.pendingRender = true; // never pull the DOM away under a drag
      return;
    }
    this.pendingRender = false;
    const focused = this.doc.activeElement;
    if (focused instanceof HTMLElement && this.root.contains(focused)) {
      this.focusCard ??= focused.dataset['cardId'];
    }
    const scroll = new Map<string, number>();
    for (const list of Array.from(this.root.querySelectorAll<HTMLElement>('[data-list-of]'))) {
      scroll.set(list.dataset['listOf'] ?? '', list.scrollTop);
    }
    this.state = this.model
      ? this.model.read()
      : { title: String(this.ctx.block.props['title'] ?? ''), columns: [] };
    const editable = this.editable;
    if (!editable) {
      this.editor = undefined;
    }
    this.root.dataset['editable'] = String(editable);
    this.root.replaceChildren(this.header(editable), this.columns(editable));
    for (const [id, top] of scroll) {
      const list = this.root.querySelector<HTMLElement>(`[data-list-of="${id}"]`);
      if (list) {
        list.scrollTop = top;
      }
    }
    const input = this.root.querySelector<HTMLInputElement>('input[data-editor]');
    if (input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (this.focusCard) {
      this.cardElement(this.focusCard)?.focus({ preventScroll: true });
    }
    this.focusCard = undefined;
  }

  private header(editable: boolean): HTMLElement {
    const head = this.el('div', 'be-kb-head');
    head.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:8px 10px 0;font-weight:600;font-size:15px';
    if (this.editor?.kind === 'title') {
      head.appendChild(this.input('Board title', this.editor, KANBAN_LIMITS.maxTitle));
      return head;
    }
    const title = this.el('span', 'be-kb-title');
    title.textContent = this.state.title || 'Kanban';
    title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    head.appendChild(title);
    if (editable) {
      head.appendChild(
        this.button('✎', 'Rename the kanban', () =>
          this.open({ kind: 'title', value: this.state.title }),
        ),
      );
    }
    return head;
  }

  private columns(editable: boolean): HTMLElement {
    const row = this.el('div', 'be-kb-cols');
    row.dataset['beScroll'] = '';
    row.style.cssText =
      'flex:1;min-height:0;display:flex;align-items:stretch;gap:8px;padding:8px;overflow-x:auto';
    const count = this.state.columns.length;
    this.state.columns.forEach((column, index) => {
      const col = this.el('section', 'be-kb-col');
      col.dataset['columnId'] = column.id;
      col.setAttribute('role', 'group');
      col.setAttribute(
        'aria-label',
        `${column.title || 'Untitled column'}, ${column.cards.length} cards`,
      );
      col.style.cssText =
        'flex:0 0 220px;display:flex;flex-direction:column;min-height:0;background:#e9eef5;border-radius:6px';
      col.appendChild(
        this.columnHeader(column.id, column.title, column.cards.length, index, count, editable),
      );
      const list = this.el('div', 'be-kb-cards');
      list.dataset['listOf'] = column.id;
      list.dataset['beScroll'] = '';
      list.setAttribute('role', 'list');
      list.style.cssText =
        'flex:1;min-height:24px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:4px 6px 6px';
      for (const card of column.cards) {
        list.appendChild(this.card(card, editable));
      }
      col.appendChild(list);
      if (editable) {
        const ed = this.editor;
        col.appendChild(
          ed?.kind === 'new-card' && ed.id === column.id
            ? this.input(`Title of a new card in ${column.title}`, ed, KANBAN_LIMITS.maxTitle)
            : this.button('+ Add card', `Add a card to ${column.title || 'the column'}`, () =>
                this.open({ kind: 'new-card', id: column.id, value: '' }),
              ),
        );
      }
      row.appendChild(col);
    });
    if (editable && count < KANBAN_LIMITS.maxColumns) {
      const ed = this.editor;
      const add =
        ed?.kind === 'new-column'
          ? this.input('Title of the new column', ed, KANBAN_LIMITS.maxColumnTitle)
          : this.button('+ Add column', 'Add a column', () =>
              this.open({ kind: 'new-column', value: '' }),
            );
      add.style.cssText += ';flex:0 0 auto;align-self:flex-start';
      row.appendChild(add);
    }
    if (count === 0 && !editable) {
      const empty = this.el('p', 'be-kb-empty');
      empty.textContent = 'No columns yet.';
      empty.style.cssText = 'margin:auto;color:#64748b';
      row.appendChild(empty);
    }
    return row;
  }

  private columnHeader(
    id: string,
    title: string,
    cards: number,
    index: number,
    count: number,
    editable: boolean,
  ): HTMLElement {
    const head = this.el('header', 'be-kb-col-head');
    head.style.cssText = 'display:flex;align-items:center;gap:4px;padding:6px 6px 2px 8px';
    const ed = this.editor;
    if (ed?.kind === 'column' && ed.id === id) {
      head.appendChild(
        this.input(`Title of the column ${title}`, ed, KANBAN_LIMITS.maxColumnTitle),
      );
      return head;
    }
    const h = this.el('h3', 'be-kb-col-title');
    h.textContent = title || 'Untitled column';
    h.style.cssText =
      'margin:0;flex:1;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const n = this.el('span', 'be-kb-count');
    n.textContent = String(cards);
    n.setAttribute('aria-hidden', 'true');
    n.style.cssText = 'color:#64748b;font-size:12px';
    head.append(h, n);
    if (editable) {
      const name = title || 'the column';
      const tools = this.el('div', 'be-kb-col-tools');
      const left = this.button('‹', `Move ${name} left`, () =>
        this.model?.moveColumn(id, index - 1),
      );
      left.disabled = index === 0;
      const right = this.button('›', `Move ${name} right`, () =>
        this.model?.moveColumn(id, index + 1),
      );
      right.disabled = index === count - 1;
      tools.append(
        left,
        right,
        this.button('✎', `Rename ${name}`, () => this.open({ kind: 'column', id, value: title })),
        this.button('✕', `Delete ${name} and its cards`, () => this.model?.deleteColumn(id)),
      );
      head.appendChild(tools);
    }
    return head;
  }

  private card(card: KanbanCard, editable: boolean): HTMLElement {
    const el = this.el('div', 'be-kb-card');
    el.dataset['cardId'] = card.id;
    el.setAttribute('role', 'listitem');
    el.setAttribute('aria-label', cardLabel(card));
    el.style.cssText =
      'background:#fff;border-radius:5px;padding:6px 8px;box-shadow:0 1px 2px rgba(15,23,42,.15);' +
      'display:flex;flex-direction:column;gap:4px;touch-action:none';
    if (editable) {
      el.tabIndex = 0;
      el.setAttribute('data-be-interactive', '');
      el.setAttribute('aria-roledescription', 'card, Enter to edit, Alt+arrows to move');
      el.addEventListener('pointerdown', (e) => this.onCardDown(e, card.id));
      el.addEventListener('pointermove', (e) => this.onCardMove(e));
      el.addEventListener('pointerup', (e) => this.onCardUp(e));
      el.addEventListener('pointercancel', (e) => {
        e.stopPropagation();
        this.endDrag();
      });
      el.addEventListener('keydown', (e) => this.onCardKey(e, card.id));
    }
    if (card.labels.length > 0) {
      const labels = this.el('div', 'be-kb-labels');
      labels.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap';
      for (const label of card.labels) {
        const chip = this.el('span', 'be-kb-label');
        chip.dataset['label'] = label;
        chip.title = LABEL_NAMES[label];
        chip.style.cssText = 'display:block;width:28px;height:6px;border-radius:3px';
        chip.style.background = labelColor(label);
        labels.appendChild(chip);
      }
      el.appendChild(labels);
    }
    const title = this.el('div', 'be-kb-card-title');
    title.textContent = card.title || 'Untitled card';
    title.style.cssText = 'overflow-wrap:anywhere;white-space:pre-wrap';
    el.appendChild(title);
    if (card.assignee || card.due || card.points !== null) {
      const meta = this.el('div', 'be-kb-meta');
      meta.style.cssText =
        'display:flex;align-items:center;gap:6px;font-size:11px;color:#475569;flex-wrap:wrap';
      if (card.due) {
        const due = this.el('span', 'be-kb-due');
        const overdue = card.due < today();
        due.dataset['overdue'] = String(overdue);
        due.textContent = formatDue(card.due);
        due.title = `Due ${card.due}`;
        due.style.color = overdue ? '#b91c1c' : '#475569';
        meta.appendChild(due);
      }
      if (card.points !== null) {
        const points = this.el('span', 'be-kb-points');
        points.textContent = String(card.points);
        points.title = `${card.points} story points`;
        points.style.cssText = 'background:#e2e8f0;border-radius:8px;padding:0 6px;font-weight:600';
        meta.appendChild(points);
      }
      if (card.assignee) {
        const who = this.el('span', 'be-kb-assignee');
        who.textContent = initials(card.assignee);
        who.title = card.assignee;
        who.style.cssText =
          'margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:20px;' +
          'height:20px;border-radius:50%;background:#1e293b;color:#fff;font-size:10px;font-weight:600';
        meta.appendChild(who);
      }
      el.appendChild(meta);
    }
    return el;
  }

  // ---- inline editors ------------------------------------------------------------------------

  private open(editor: Editor): void {
    this.editor = editor;
    this.render();
  }

  private input(label: string, editor: Editor, max: number): HTMLElement {
    const input = this.el('input', 'be-kb-input') as HTMLInputElement;
    input.type = 'text';
    input.dataset['editor'] = editor.kind;
    input.setAttribute('aria-label', label);
    input.maxLength = max;
    input.value = editor.value;
    input.setAttribute('data-be-interactive', '');
    input.style.cssText =
      'font:inherit;width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid #2563eb;border-radius:4px;background:#fff';
    input.addEventListener('input', () => (editor.value = input.value));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit(editor, input.value, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    input.addEventListener('blur', () => {
      // a re-render replaces the input; only a real blur of the current editor commits
      if (this.editor === editor && input.isConnected) {
        this.commit(editor, input.value, false);
      }
    });
    return input;
  }

  private commit(editor: Editor, raw: string, viaEnter: boolean): void {
    const value = raw.trim();
    const model = this.model;
    if (!model) {
      return;
    }
    switch (editor.kind) {
      case 'title':
        this.editor = undefined;
        model.setTitle(value);
        break;
      case 'column':
        this.editor = undefined;
        if (value !== '') {
          model.renameColumn(editor.id, value);
        }
        break;
      case 'new-column':
        this.editor = undefined;
        if (value !== '') {
          model.addColumn(value);
        }
        break;
      case 'new-card':
        // Enter keeps the field open for the next card; leaving it adds what was typed
        this.editor = viaEnter && value !== '' ? { ...editor, value: '' } : undefined;
        if (value !== '') {
          model.addCard(editor.id, value);
        }
        break;
    }
    this.render();
  }

  private close(): void {
    this.editor = undefined;
    this.render();
  }

  // ---- keyboard ------------------------------------------------------------------------------

  private onCardKey(e: KeyboardEvent, id: string): void {
    const pos = this.position(id);
    const model = this.model;
    if (!pos || !model) {
      return;
    }
    const { col, row } = pos;
    const columns = this.state.columns;
    let handled = true;
    if (e.key === 'Enter' || e.key === ' ') {
      this.openCard(id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const cards = columns[col]?.cards ?? [];
      this.focusCard = (cards[row + 1] ?? cards[row - 1])?.id;
      model.deleteCard(id);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const target = row + (e.key === 'ArrowUp' ? -1 : 1);
      this.focusCard = id;
      model.moveCard(id, columns[col]?.id ?? '', Math.max(0, target));
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const target = columns[col + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (target) {
        this.focusCard = id;
        model.moveCard(id, target.id, row);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = columns[col]?.cards[row + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) {
        this.cardElement(next.id)?.focus();
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const cards = columns[col + (e.key === 'ArrowLeft' ? -1 : 1)]?.cards ?? [];
      const next = cards[Math.min(row, cards.length - 1)];
      if (next) {
        this.cardElement(next.id)?.focus();
      }
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private openCard(id: string): void {
    this.host?.request({ blockId: this.ctx.block.id, action: KANBAN_CARD_ACTION, itemId: id });
  }

  // ---- drag ----------------------------------------------------------------------------------

  private onCardDown(e: PointerEvent, cardId: string): void {
    e.stopPropagation();
    if (e.button !== 0 || this.drag) {
      return;
    }
    this.drag = {
      cardId,
      pointerId: e.pointerId,
      start: { x: e.clientX, y: e.clientY },
      active: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointers (tests) cannot be captured
    }
  }

  private onCardMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    e.stopPropagation();
    if (
      !drag.active &&
      Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < DRAG_THRESHOLD
    ) {
      return;
    }
    if (!drag.active) {
      drag.active = true;
      this.cardElement(drag.cardId)?.style.setProperty('opacity', '0.4');
      drag.ghost = this.ghost(drag.cardId);
    }
    if (drag.ghost) {
      drag.ghost.style.left = `${e.clientX + 8}px`;
      drag.ghost.style.top = `${e.clientY + 8}px`;
    }
    drag.target = this.targetAt(e.clientX, e.clientY, drag.cardId);
    this.showMarker(drag);
  }

  private onCardUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    e.stopPropagation();
    if (!drag.active) {
      this.endDrag();
      this.openCard(drag.cardId);
      return;
    }
    const target = this.targetAt(e.clientX, e.clientY, drag.cardId);
    this.endDrag();
    if (target === 'out') {
      this.dropOut(drag.cardId, e.clientX, e.clientY, e.shiftKey);
    } else if (target) {
      this.focusCard = drag.cardId;
      this.model?.moveCard(drag.cardId, target.columnId, target.index);
    }
    this.render();
  }

  /** The card leaves the kanban and becomes a block on the canvas: one undo step. */
  private dropOut(cardId: string, clientX: number, clientY: number, alternative: boolean): void {
    const host = this.host;
    if (!host || !this.model) {
      return;
    }
    const at = host.worldAtClient(clientX, clientY);
    const make = alternative && this.out.alternative ? this.out.alternative : this.out.sticky;
    const id = this.model.moveCardOut(cardId, (card) => host.board.addBlock(make(card, at)));
    if (id) {
      host.select([id]);
    }
  }

  /** Where a drop at a viewport point would go: a column and index, outside, or nowhere. */
  private targetAt(
    x: number,
    y: number,
    cardId: string,
  ): { columnId: string; index: number } | 'out' | undefined {
    const inside = (r: DOMRect): boolean =>
      x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (!inside(this.root.getBoundingClientRect())) {
      return 'out';
    }
    for (const col of Array.from(this.root.querySelectorAll<HTMLElement>('[data-column-id]'))) {
      const r = col.getBoundingClientRect();
      if (x < r.left || x > r.right) {
        continue;
      }
      const cards = Array.from(col.querySelectorAll<HTMLElement>('[data-card-id]')).filter(
        (c) => c.dataset['cardId'] !== cardId,
      );
      const index = cards.filter((c) => {
        const cr = c.getBoundingClientRect();
        return cr.top + cr.height / 2 < y;
      }).length;
      return { columnId: col.dataset['columnId'] ?? '', index };
    }
    return undefined;
  }

  private showMarker(drag: Drag): void {
    drag.marker?.remove();
    drag.marker = undefined;
    if (drag.ghost) {
      drag.ghost.dataset['out'] = String(drag.target === 'out');
      drag.ghost.style.outline = drag.target === 'out' ? '2px dashed #2563eb' : 'none';
    }
    const target = drag.target;
    if (!target || target === 'out') {
      return;
    }
    const list = this.root.querySelector<HTMLElement>(`[data-list-of="${target.columnId}"]`);
    if (!list) {
      return;
    }
    const marker = this.el('div', 'be-kb-drop');
    marker.style.cssText = 'height:3px;border-radius:2px;background:#2563eb;flex:none';
    const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-card-id]')).filter(
      (c) => c.dataset['cardId'] !== drag.cardId,
    );
    list.insertBefore(marker, cards[target.index] ?? null);
    drag.marker = marker;
  }

  /** A copy of the card that follows the pointer in screen space (outside the zoomed world). */
  private ghost(cardId: string): HTMLElement {
    const ghost = this.el('div', 'be-kb-ghost');
    ghost.textContent =
      this.cardElement(cardId)?.querySelector('.be-kb-card-title')?.textContent ?? '';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.cssText =
      'position:fixed;z-index:1000;pointer-events:none;max-width:220px;padding:6px 8px;background:#fff;' +
      'border-radius:5px;box-shadow:0 8px 20px rgba(15,23,42,.25);font:13px system-ui,sans-serif;color:#1f2937';
    this.doc.body.appendChild(ghost);
    return ghost;
  }

  private endDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) {
      return;
    }
    drag.ghost?.remove();
    drag.marker?.remove();
    this.cardElement(drag.cardId)?.style.removeProperty('opacity');
    if (this.pendingRender) {
      this.render();
    }
  }

  // ---- helpers -------------------------------------------------------------------------------

  private position(id: string): { col: number; row: number } | undefined {
    for (const [col, column] of this.state.columns.entries()) {
      const row = column.cards.findIndex((c) => c.id === id);
      if (row >= 0) {
        return { col, row };
      }
    }
    return undefined;
  }

  /** Card ids come from `readKanban`, which accepts only UUIDs: safe inside a selector. */
  private cardElement(id: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  }

  private el(tag: string, className: string): HTMLElement {
    const el = this.doc.createElement(tag);
    el.className = className;
    return el;
  }

  private button(text: string, label: string, action: () => void): HTMLButtonElement {
    const b = this.el('button', 'be-kb-btn') as HTMLButtonElement;
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.setAttribute('data-be-interactive', '');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    return b;
  }
}
