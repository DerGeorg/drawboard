import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { EstimationItem, EstimationSession } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import { BoardEstimation } from '../board-estimation';
import { LiveItem, display, isPlainLine, liveItem } from '../estimation-items';

/** Longest reason (contract `RotationEstimate.reason`). */
export const MAX_REASON = 280;

/** What the caller is about to enter for one card in this round. */
interface Draft {
  value?: string;
  reason: string;
}

/** One card the caller holds in this round, as the panel shows it. */
interface HeldCard {
  readonly item: EstimationItem;
  /** The card read live from the document (E20); undefined when it is gone. */
  readonly live: LiveItem | undefined;
  readonly title: string;
  readonly draft: Draft;
  /** The round this card was shown for: the entry is meant for it (E14). */
  readonly round: number;
}

/**
 * Rotation "my cards" (architecture 3.15): the cards the caller holds in the current round
 * (`mine`), their title and details read live from the document by ref (the stored copy when
 * the card is gone), the previous estimate (`currentValue`) without author, reason or round
 * (E4), the deck, and a reason that is required when the value differs from the previous one
 * (a card without a previous value needs none). "Keep" takes the previous value. Every entry
 * names the round it is meant for (E14). Progress is per seat only (`done`), never per card
 * (E3). Nothing here selects a block or moves the camera: both go out in awareness with the
 * caller's name and would show who holds which card (Fable F1).
 */
@Component({
  selector: 'drawboard-rotation-panel',
  templateUrl: './rotation-panel.html',
})
export class RotationPanel {
  private readonly estimation = inject(BoardEstimation);
  private readonly messages = inject(ErrorMessages);

  readonly session = input.required<EstimationSession>();
  readonly engine = input.required<BoardEngine>();

  protected readonly display = display;
  protected readonly maxReason = MAX_REASON;
  protected readonly busy = signal<string | undefined>(undefined);
  protected readonly message = signal<string | undefined>(undefined);
  /** Drafts per card of the current round (`<round>/<item id>`). */
  private readonly drafts = signal<ReadonlyMap<string, Draft>>(new Map());
  private readonly revision = signal(0);

  protected readonly seated = computed(() => this.session().seats.filter((s) => s.seated));
  protected readonly doneCount = computed(() => this.seated().filter((s) => s.done).length);
  protected readonly cards = computed<HeldCard[]>(() => {
    this.revision();
    const s = this.session();
    const board = this.engine().board;
    return s.items
      .filter((item) => item.mine)
      .map((item) => {
        const live = liveItem(board, item.ref);
        return {
          item,
          live,
          title: live?.title.trim() || item.title,
          draft: this.drafts().get(this.key(item)) ?? { value: item.myEntry?.value, reason: '' },
          round: s.round,
        };
      });
  });

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      onCleanup(engine.board.observe(() => this.revision.update((r) => r + 1)));
    });
  }

  /** A reason is needed when a previous value exists and the chosen one differs. */
  protected needsReason(card: HeldCard): boolean {
    const previous = card.item.currentValue;
    return (
      previous !== undefined && card.draft.value !== undefined && card.draft.value !== previous
    );
  }

  /** Why "Save" is not possible yet; undefined when it is. */
  protected problem(card: HeldCard): string | undefined {
    if (card.draft.value === undefined) {
      return 'Pick a value.';
    }
    const reason = card.draft.reason.trim();
    if (this.needsReason(card) && reason === '') {
      return 'Say why you change the previous estimate.';
    }
    if (reason.length > MAX_REASON) {
      return `At most ${MAX_REASON} characters.`;
    }
    if (!isPlainLine(card.draft.reason)) {
      return 'One line of plain text, please.';
    }
    return undefined;
  }

  @WithSpan('RotationPanel.pick')
  protected pick(card: HeldCard, value: string): void {
    this.update(card, { value });
  }

  protected typeReason(card: HeldCard, event: Event): void {
    this.update(card, { reason: (event.target as HTMLInputElement).value });
  }

  /** Keeps the previous value (no reason; the server discards one anyway). */
  @WithSpan('RotationPanel.keep')
  protected async keep(card: HeldCard): Promise<void> {
    const previous = card.item.currentValue;
    if (previous !== undefined) {
      this.update(card, { value: previous, reason: '' });
      await this.send(card, { value: previous });
    }
  }

  @WithSpan('RotationPanel.save')
  protected async save(card: HeldCard): Promise<void> {
    if (this.problem(card) || card.draft.value === undefined) {
      return;
    }
    const reason = card.draft.reason.trim().normalize('NFC');
    await this.send(card, {
      value: card.draft.value,
      ...(this.needsReason(card) ? { reason } : {}),
    });
  }

  /** Sends the entry for the round the card was shown in, never a later one (E14). */
  private async send(card: HeldCard, entry: { value: string; reason?: string }) {
    const item = card.item;
    this.busy.set(item.id);
    this.message.set(undefined);
    try {
      await this.estimation.estimate(this.session().id, item.id, { ...entry, round: card.round });
    } catch (error) {
      // never the reason in a message (E12): the server does not echo it, nor do we
      this.message.set(
        error instanceof ApiError
          ? this.messages.text(error.problem)
          : 'The estimate was not saved.',
      );
    } finally {
      this.busy.set(undefined);
    }
  }

  private key(item: EstimationItem): string {
    return `${this.session().round}/${item.id}`;
  }

  private update(card: HeldCard, patch: Partial<Draft>): void {
    this.drafts.update((m) =>
      new Map(m).set(`${card.round}/${card.item.id}`, { ...card.draft, ...patch }),
    );
  }
}
