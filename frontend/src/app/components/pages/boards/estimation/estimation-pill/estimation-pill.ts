import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import {
  EstimationMode,
  EstimationSessionState,
  EstimationSessionSummary,
} from '@apps/drawboard-api';

import { WithSpan } from '../../../../../util/tracing';
import { BoardEstimation } from '../board-estimation';
import { isRunning } from '../estimation-lease';

/** How a state is named in the menu. */
export const STATE_NAMES: Readonly<Record<EstimationSessionState, string>> = {
  LOBBY: 'lobby',
  PLACING: 'placing',
  MOVING: 'moving',
  ROTATING: 'rotating',
  REVIEW: 'review',
  DONE: 'done',
  CANCELLED: 'cancelled',
};

export const MODE_NAMES: Readonly<Record<EstimationMode, string>> = {
  MAGIC: 'Magic Estimation',
  ROTATION: 'Rotation',
};

/**
 * The estimation sessions of a board in the toolbar (next to the planning poker pill): how many
 * are active, a menu to open one, and - for signed-in editors and owners - "New estimation
 * session". Opening the menu lists the sessions again (throttled). The chip "in estimation" comes
 * from the server's list (`me.seated`), never from awareness (E19). Members may also look at
 * finished sessions (guests cannot list them, E8). Hidden for VIEWER-link guests.
 */
@Component({
  selector: 'drawboard-estimation-pill',
  templateUrl: './estimation-pill.html',
  host: {
    '(keydown.escape)': 'menu.set(false)',
    '(document:pointerdown)': 'closeOnOutside($event)',
  },
})
export class EstimationPill {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly estimation = inject(BoardEstimation);

  /** The board is read-only for this client (no session can be created then). */
  readonly readOnly = input(false);
  /** A session was picked: the page opens it. */
  readonly open = output<string>();
  /** "New estimation session" was picked: the page opens the setup dialog. */
  readonly create = output();

  protected readonly menu = signal(false);
  protected readonly showClosed = signal(false);
  protected readonly modes = MODE_NAMES;
  protected readonly states = STATE_NAMES;
  protected readonly available = computed(() => this.estimation.access() !== 'none');
  protected readonly sessions = computed(() =>
    this.available() ? this.estimation.sessions() : [],
  );
  protected readonly canCreate = computed(
    () => this.estimation.access() === 'create' && !this.readOnly(),
  );
  /** Members only: guests cannot list closed sessions. */
  protected readonly canSeeClosed = computed(() => this.available() && !this.estimation.isGuest());

  protected inSession(summary: EstimationSessionSummary): boolean {
    return summary.me.seated && isRunning(summary.state);
  }

  @WithSpan('EstimationPill.toggle')
  protected toggle(): void {
    this.menu.update((m) => !m);
    if (this.menu()) {
      this.estimation.loadSessions();
    }
  }

  @WithSpan('EstimationPill.pick')
  protected pick(summary: EstimationSessionSummary): void {
    this.menu.set(false);
    this.open.emit(summary.id);
  }

  @WithSpan('EstimationPill.startNew')
  protected startNew(): void {
    this.menu.set(false);
    if (this.canCreate()) {
      this.create.emit();
    }
  }

  @WithSpan('EstimationPill.toggleClosed')
  protected toggleClosed(): void {
    this.showClosed.update((s) => !s);
    if (this.showClosed()) {
      this.estimation.loadClosed();
    }
  }

  protected closeOnOutside(event: Event): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.menu.set(false);
    }
  }
}
