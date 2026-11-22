import { Component, computed, effect, inject, input, signal } from '@angular/core';
import {
  EstimationItem,
  EstimationMode,
  EstimationSession,
  EstimationSessionState,
} from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import { BoardEstimation } from '../board-estimation';
import {
  WriteCheck,
  checkWrite,
  display,
  focusRef,
  liveItem,
  magicColumns,
  writeDecision,
} from '../estimation-items';

/** One card of the review. */
interface ReviewCard {
  readonly item: EstimationItem;
  /** The live title, or the stored copy when the card is gone. */
  readonly title: string;
  /** The stored copy when the live title differs from it (E21 SHOULD). */
  readonly storedTitle: string | undefined;
  /** The values the moderator may pick; `override` marks values that would be `overridden`. */
  readonly choices: readonly { value: string; override: boolean }[];
  /** DONE: whether and how the decision can be written into the card (E21). */
  readonly write: WriteCheck | undefined;
}

/**
 * The review of a session (from REVIEW on): per card the average, median and distribution, all
 * values and reasons (plain text by interpolation, never links, never in toasts, spans, Faro or
 * local storage, E12), names only when the session is not anonymous (E5), and for Magic the
 * columns the card went through. The moderator decides per card - Rotation from the values
 * entered (any deck value only for a card without any, then `overridden`), Magic from the deck
 * - and finishes. After DONE a client that may edit writes the decisions into the cards (E21):
 * only when block, type and card still match the ref, showing the live title and the card's
 * current value first; any editor may do it later from a DONE session.
 */
@Component({
  selector: 'drawboard-estimation-review',
  templateUrl: './estimation-review.html',
})
export class EstimationReview {
  private readonly estimation = inject(BoardEstimation);
  private readonly messages = inject(ErrorMessages);

  readonly session = input.required<EstimationSession>();
  readonly engine = input.required<BoardEngine>();
  /** The board is read-only for this client: decisions are not written. */
  readonly readOnly = input(false);

  protected readonly display = display;
  protected readonly busy = signal(false);
  protected readonly message = signal<string | undefined>(undefined);
  /** Cards whose decision this client wrote. */
  protected readonly written = signal<ReadonlySet<string>>(new Set());
  private readonly revision = signal(0);

  protected readonly magic = computed(() => this.session().mode === EstimationMode.MAGIC);
  protected readonly done = computed(() => this.session().state === EstimationSessionState.DONE);
  protected readonly canDecide = computed(
    () => this.session().me.moderator && this.session().state === EstimationSessionState.REVIEW,
  );
  protected readonly canWrite = computed(() => this.done() && !this.readOnly());
  protected readonly decidedCount = computed(
    () => this.session().items.filter((i) => i.decision !== undefined).length,
  );
  protected readonly cards = computed<ReviewCard[]>(() => {
    this.revision();
    const s = this.session();
    const board = this.engine().board;
    const deck = s.deck.values ?? [];
    return s.items.map((item) => {
      const live = liveItem(board, item.ref);
      const liveTitle = live?.title.trim();
      const candidates = item.result?.candidates ?? [];
      let choices: { value: string; override: boolean }[];
      if (this.magic()) {
        choices = magicColumns(s.deck).map((value) => ({
          value,
          override: !item.marked && !candidates.includes(value),
        }));
      } else if (candidates.length > 0) {
        choices = candidates.map((value) => ({ value, override: false }));
      } else {
        choices = deck.map((value) => ({ value, override: true }));
      }
      return {
        item,
        title: liveTitle || item.title,
        storedTitle: liveTitle && liveTitle !== item.title ? item.title : undefined,
        choices,
        write:
          item.decision !== undefined && this.done()
            ? checkWrite(board, item.ref, item.decision)
            : undefined,
      };
    });
  });
  protected readonly writable = computed(() =>
    this.cards().filter(
      (c) =>
        c.write?.ok &&
        !this.written().has(c.item.id) &&
        c.write.live.estimate !== (c.item.decision ?? null),
    ),
  );

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      onCleanup(engine.board.observe(() => this.revision.update((r) => r + 1)));
    });
  }

  protected maxCount(item: EstimationItem): number {
    return Math.max(1, ...(item.result?.distribution.map((d) => d.count) ?? []));
  }

  protected width(count: number, item: EstimationItem): string {
    return `${Math.round((count / this.maxCount(item)) * 100)}%`;
  }

  /** Whether the decision is already on the card. */
  protected onCard(card: ReviewCard): boolean {
    return !!card.write?.ok && card.write.live.estimate === (card.item.decision ?? null);
  }

  @WithSpan('EstimationReview.show')
  protected show(card: ReviewCard): void {
    focusRef(this.engine(), card.item.ref);
  }

  @WithSpan('EstimationReview.decide')
  protected async decide(card: ReviewCard, value: string): Promise<void> {
    if (this.canDecide()) {
      await this.run(() => this.estimation.decide(this.session().id, card.item.id, value));
    }
  }

  @WithSpan('EstimationReview.finish')
  protected async finish(): Promise<void> {
    if (this.canDecide()) {
      await this.run(async () => {
        await this.estimation.finish(this.session().id);
      });
    }
  }

  /** Writes one decision into its card: an ordinary editor update (E21). */
  @WithSpan('EstimationReview.write')
  protected write(card: ReviewCard): void {
    const engine = this.engine();
    const value = card.item.decision;
    if (!this.canWrite() || engine.readOnly || value === undefined) {
      return;
    }
    if (writeDecision(engine.board, card.item.ref, value, () => engine.stopCapturing())) {
      this.written.update((w) => new Set(w).add(card.item.id));
    }
  }

  @WithSpan('EstimationReview.writeAll')
  protected writeAll(): void {
    for (const card of this.writable()) {
      this.write(card);
    }
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.message.set(undefined);
    try {
      await operation();
    } catch (error) {
      this.message.set(
        error instanceof ApiError ? this.messages.text(error.problem) : 'Something went wrong.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
