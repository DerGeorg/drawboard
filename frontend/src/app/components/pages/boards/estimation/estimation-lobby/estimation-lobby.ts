import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { EstimationMode, EstimationSession } from '@apps/drawboard-api';

import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import { BoardEstimation } from '../board-estimation';
import { display } from '../estimation-items';

/** Seats a session needs at least to start (contract `EstimationStart.seatIds`). */
export const MIN_SEATS = 2;

/**
 * The lobby of a session: everything fixed at creation (mode, deck, cards, timing, anonymity,
 * E1) before anyone joins, the named limits of anonymity (E6), who joined, and join/leave.
 * The moderator picks who takes part and starts: 2 to 30 seats, never more seats than cards
 * (C3) and, for Rotation, at least as many seats as rounds (E7).
 */
@Component({
  selector: 'drawboard-estimation-lobby',
  templateUrl: './estimation-lobby.html',
})
export class EstimationLobby {
  private readonly estimation = inject(BoardEstimation);
  private readonly messages = inject(ErrorMessages);

  readonly session = input.required<EstimationSession>();

  protected readonly busy = signal(false);
  protected readonly message = signal<string | undefined>(undefined);
  protected readonly magic = computed(() => this.session().mode === EstimationMode.MAGIC);
  protected readonly joined = computed(() => !!this.session().me.seatId);
  protected readonly canJoin = computed(() => {
    const access = this.estimation.access();
    return access === 'join' || access === 'create';
  });
  protected readonly moderator = computed(() => this.session().me.moderator);
  protected readonly deckLine = computed(
    () =>
      this.session()
        .deck.values?.map((v) => display(v))
        .join(', ') ?? '',
  );
  /** The seats the moderator picked; every joined seat until they change it. */
  protected readonly picked = linkedSignal<EstimationSession, ReadonlySet<string>>({
    source: () => this.session(),
    computation: (session, previous) => {
      const ids = session.seats.map((s) => s.id);
      if (!previous) {
        return new Set(ids);
      }
      // keep the choice; new seats come in picked, gone seats drop out
      const before = new Set(previous.source.seats.map((s) => s.id));
      return new Set(ids.filter((id) => previous.value.has(id) || !before.has(id)));
    },
  });
  protected readonly pickedCount = computed(
    () => this.session().seats.filter((s) => this.picked().has(s.id)).length,
  );
  /** Why the moderator cannot start yet, in words; undefined when they can. */
  protected readonly startProblem = computed(() => {
    const s = this.session();
    const n = this.pickedCount();
    const cards = s.items.length;
    if (n < MIN_SEATS) {
      return `Pick at least ${MIN_SEATS} people to start.`;
    }
    if (n > cards) {
      return `Pick at most ${cards} ${cards === 1 ? 'person' : 'people'}: everyone needs at least one card, and this session has ${cards} ${cards === 1 ? 'card' : 'cards'}.`;
    }
    const rounds = s.settings.rounds ?? 1;
    if (s.mode === EstimationMode.ROTATION && n < rounds) {
      return `Pick at least ${rounds} people: no one may hold a card twice in ${rounds} rounds.`;
    }
    return undefined;
  });

  protected display(value: string): string {
    return display(value);
  }

  protected isPicked(id: string): boolean {
    return this.picked().has(id);
  }

  @WithSpan('EstimationLobby.togglePick')
  protected togglePick(id: string): void {
    const next = new Set(this.picked());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.picked.set(next);
  }

  @WithSpan('EstimationLobby.join')
  protected async join(): Promise<void> {
    await this.run(() => this.estimation.join(this.session().id));
  }

  @WithSpan('EstimationLobby.leave')
  protected async leave(): Promise<void> {
    await this.run(() => this.estimation.leave(this.session().id));
  }

  @WithSpan('EstimationLobby.start')
  protected async start(): Promise<void> {
    if (this.startProblem()) {
      return;
    }
    const ids = this.session()
      .seats.filter((s) => this.picked().has(s.id))
      .map((s) => s.id);
    await this.run(async () => {
      await this.estimation.start(this.session().id, ids);
    });
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
