import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { EstimationItem, EstimationSession, EstimationSessionState } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import { BoardEstimation } from '../board-estimation';
import { display, liveItem, magicColumns } from '../estimation-items';

/** A press that moves less than this is no drag. */
const DRAG_SLOP_PX = 4;

interface Drag {
  itemId: string;
  /** The phase the drag started in: the placement is meant for it (E14). */
  state: EstimationSessionState;
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  moved: boolean;
}

/** One card as the board shows it. */
interface MagicCard {
  readonly item: EstimationItem;
  readonly title: string;
  readonly column: string | undefined;
  readonly draggable: boolean;
}

/**
 * The Magic Estimation board over the canvas (architecture 3.15): one column per deck value
 * without `coffee`, `?` as the parking column, and the cards. PLACING: the caller places only
 * the cards dealt to them, the others stay hidden (E3, E4). MOVING: every seated participant
 * may move every card; each card shows how often it moved and whether it is marked - never who
 * moved it. It is an overlay, not Yjs blocks (E20), and nothing of it goes into awareness - no
 * cursor, no drag (E19): a drag is local until the drop, then one placement request with the
 * phase the caller sees (E14).
 */
@Component({
  selector: 'drawboard-magic-overlay',
  imports: [NgTemplateOutlet],
  templateUrl: './magic-overlay.html',
})
export class MagicOverlay {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly estimation = inject(BoardEstimation);
  private readonly messages = inject(ErrorMessages);

  readonly session = input.required<EstimationSession>();
  readonly engine = input.required<BoardEngine>();
  /** Milliseconds left in the phase (server clock); undefined without a deadline. */
  readonly remainingMs = input<number | undefined>(undefined);

  protected readonly display = display;
  protected readonly drag = signal<Drag | undefined>(undefined);
  /** The column under the dragged card. */
  protected readonly hovered = signal<string | null | undefined>(undefined);
  /** Drops on their way to the server: shown at once. */
  private readonly pending = signal<ReadonlyMap<string, string | null>>(new Map());
  protected readonly message = signal<string | undefined>(undefined);
  /** Live titles from the document (E20), refreshed when the board changes. */
  private readonly revision = signal(0);

  protected readonly placing = computed(
    () => this.session().state === EstimationSessionState.PLACING,
  );
  protected readonly seated = computed(() => this.session().me.seated);
  protected readonly columns = computed(() => magicColumns(this.session().deck));
  protected readonly cards = computed<MagicCard[]>(() => {
    this.revision();
    const s = this.session();
    const pending = this.pending();
    const board = this.engine().board;
    return s.items
      .filter((item) => !this.placing() || item.mine)
      .map((item) => {
        const column = pending.has(item.id) ? (pending.get(item.id) ?? undefined) : item.column;
        return {
          item,
          title: liveItem(board, item.ref)?.title.trim() || item.title,
          column,
          draggable: this.seated() && (this.placing() ? item.mine : true),
        };
      });
  });
  protected readonly byColumn = computed(() => {
    const map = new Map<string, MagicCard[]>(this.columns().map((c) => [c, []]));
    for (const card of this.cards()) {
      if (card.column !== undefined) {
        map.get(card.column)?.push(card);
      }
    }
    return map;
  });
  protected readonly unplaced = computed(() =>
    this.cards().filter((c) => c.column === undefined || !this.columns().includes(c.column)),
  );
  /** PLACING: the others' cards are hidden; only their number is known. */
  protected readonly hiddenCount = computed(() =>
    this.placing() ? this.session().items.filter((i) => !i.mine).length : 0,
  );
  protected readonly phaseSeconds = computed(() => {
    const settings = this.session().settings;
    return (this.placing() ? settings.placingSeconds : settings.movingSeconds) ?? 0;
  });
  /** Share of the phase that is left, 0..100, for the timer bar. */
  protected readonly timeLeft = computed(() => {
    const ms = this.remainingMs();
    const total = this.phaseSeconds() * 1000;
    return ms === undefined || total <= 0 ? 0 : Math.min(100, Math.round((ms / total) * 100));
  });

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      onCleanup(engine.board.observe(() => this.revision.update((r) => r + 1)));
    });
    // a new phase ends a running drag
    effect(() => {
      const state = this.session().state;
      const drag = untracked(() => this.drag());
      if (drag && drag.state !== state) {
        untracked(() => this.pointerCancel());
      }
    });
  }

  /** A drop zone lights up while a card is over it. */
  protected zoneClass(column: string | null): string {
    return this.hovered() === column
      ? 'border-(--color-st-yellow) bg-(--color-st-yellow-transparent)'
      : 'border-(--color-st-white-darker)';
  }

  protected labelOf(card: MagicCard): string {
    const where = card.column === undefined ? 'not placed' : `in column ${display(card.column)}`;
    const moves = card.item.moveCount ? `, moved ${card.item.moveCount} times` : '';
    const marked = card.item.marked ? ', marked' : '';
    return `${card.title}, ${where}${moves}${marked}`;
  }

  // ---- pointer drag (local only, E19) --------------------------------------------------------

  protected pointerDown(event: PointerEvent, card: MagicCard): void {
    if (!card.draggable || event.button !== 0) {
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.drag.set({
      itemId: card.item.id,
      state: this.session().state,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      moved: false,
    });
  }

  protected pointerMove(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    this.drag.set({
      ...drag,
      dx,
      dy,
      moved: drag.moved || Math.hypot(dx, dy) > DRAG_SLOP_PX,
    });
    this.hovered.set(this.columnAt(event.clientX, event.clientY));
  }

  protected pointerUp(event: PointerEvent): void {
    const drag = this.drag();
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    this.drag.set(undefined);
    this.hovered.set(undefined);
    // a phase that changed during the drag ends it: the cards are not where they were
    if (!drag.moved || drag.state !== this.session().state) {
      return;
    }
    const target = this.columnAt(event.clientX, event.clientY);
    if (target !== undefined) {
      void this.place(drag.itemId, target, drag.state);
    }
  }

  protected pointerCancel(): void {
    this.drag.set(undefined);
    this.hovered.set(undefined);
  }

  protected offset(card: MagicCard): string | null {
    const drag = this.drag();
    return drag?.itemId === card.item.id && drag.moved
      ? `translate(${drag.dx}px, ${drag.dy}px)`
      : null;
  }

  // ---- keyboard ------------------------------------------------------------------------------

  /** Arrow keys move a card to the neighbouring column; Delete takes an own card out (PLACING). */
  @WithSpan('MagicOverlay.key')
  protected key(event: KeyboardEvent, card: MagicCard): void {
    if (!card.draggable) {
      return;
    }
    const columns = this.columns();
    const index = card.column === undefined ? -1 : columns.indexOf(card.column);
    let target: string | null | undefined;
    if (event.key === 'ArrowRight') {
      target = columns[Math.min(columns.length - 1, index + 1)];
    } else if (event.key === 'ArrowLeft') {
      target = index <= 0 ? (this.placing() ? null : columns[0]) : columns[index - 1];
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.placing()) {
      target = null;
    } else {
      return;
    }
    event.preventDefault();
    if (target !== undefined && target !== (card.column ?? null)) {
      void this.place(card.item.id, target, this.session().state);
    }
  }

  // ---- placement -----------------------------------------------------------------------------

  /** The column (or, in PLACING, the tray = null) under a point; undefined for elsewhere. */
  private columnAt(x: number, y: number): string | null | undefined {
    const zones = this.host.nativeElement.querySelectorAll<HTMLElement>('[data-drop]');
    for (const zone of Array.from(zones)) {
      const r = zone.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const value = zone.dataset['drop'] ?? '';
        if (value === '') {
          return this.placing() ? null : undefined;
        }
        return this.columns().includes(value) ? value : undefined;
      }
    }
    return undefined;
  }

  @WithSpan('MagicOverlay.place')
  private async place(
    itemId: string,
    value: string | null,
    state: EstimationSessionState,
  ): Promise<void> {
    const s = this.session();
    const card = this.cards().find((c) => c.item.id === itemId);
    if (!card?.draggable || (value === null && state !== EstimationSessionState.PLACING)) {
      return;
    }
    this.message.set(undefined);
    this.pending.update((m) => new Map(m).set(itemId, value));
    try {
      await this.estimation.place(s.id, itemId, value, state);
    } catch (error) {
      this.message.set(
        error instanceof ApiError
          ? this.messages.text(error.problem)
          : 'The card could not be moved.',
      );
    } finally {
      this.pending.update((m) => {
        const next = new Map(m);
        next.delete(itemId);
        return next;
      });
    }
  }
}
