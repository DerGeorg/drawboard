import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { EstimationMode, EstimationSessionState } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import { Icon } from '../../../../shared/icon/icon';
import { BoardEstimation } from '../board-estimation';
import { EstimationLease, isClosed, isRunning } from '../estimation-lease';
import { EstimationLobby } from '../estimation-lobby/estimation-lobby';
import { MODE_NAMES, STATE_NAMES } from '../estimation-pill/estimation-pill';
import { EstimationReview } from '../estimation-review/estimation-review';
import { MagicOverlay } from '../magic-overlay/magic-overlay';
import { RotationPanel } from '../rotation-panel/rotation-panel';

/** "2:05" for a countdown. */
export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

let nextId = 0;

/**
 * One estimation session, opened from the pill or after its creation: holds the session's lease
 * (polling, server clock) while open and shows the part of the state the caller is in - lobby,
 * the Magic board over the canvas, the Rotation panel, the review. The header carries the
 * countdown and the moderator's controls (end the phase or round early with the expected
 * state and round, E14; cancel). Errors stay in the panel: a session the caller may not see
 * (any more) just says so (VIEWER-link guests never get here, E8).
 */
@Component({
  selector: 'drawboard-estimation-panel',
  imports: [Icon, EstimationLobby, MagicOverlay, RotationPanel, EstimationReview],
  templateUrl: './estimation-panel.html',
  host: { '(keydown.escape)': 'close()' },
})
export class EstimationPanel {
  private readonly estimation = inject(BoardEstimation);
  private readonly messages = inject(ErrorMessages);

  readonly engine = input.required<BoardEngine>();
  readonly sessionId = input.required<string>();
  /** The board is read-only for this client (no results are written then). */
  readonly readOnly = input(false);
  readonly closed = output();

  protected readonly ids = `estimation-${nextId++}`;
  protected readonly states = EstimationSessionState;
  protected readonly modeNames = MODE_NAMES;
  protected readonly stateNames = STATE_NAMES;
  protected readonly lease = signal<EstimationLease | undefined>(undefined);
  protected readonly session = computed(() => this.lease()?.session());
  protected readonly gone = computed(() => {
    const end = this.lease()?.end();
    return end === 'gone' || end === 'forbidden';
  });
  protected readonly busy = signal(false);
  protected readonly message = signal<string | undefined>(undefined);
  protected readonly confirmCancel = signal(false);
  /** The Magic board covers the canvas while cards are placed and moved. */
  protected readonly wide = computed(() => {
    const s = this.session();
    return (
      s?.mode === EstimationMode.MAGIC &&
      (s.state === EstimationSessionState.PLACING || s.state === EstimationSessionState.MOVING)
    );
  });
  protected readonly countdown = computed(() => {
    const ms = this.lease()?.remainingMs();
    return ms === undefined ? undefined : clock(ms);
  });
  protected readonly roundLine = computed(() => {
    const s = this.session();
    return s?.state === EstimationSessionState.ROTATING
      ? `Round ${s.round + 1} of ${s.settings.rounds ?? 1}`
      : undefined;
  });
  protected readonly canAdvance = computed(() => {
    const s = this.session();
    return !!s && s.me.moderator && isRunning(s.state);
  });
  protected readonly canCancel = computed(() => {
    const s = this.session();
    return !!s && s.me.moderator && !isClosed(s.state);
  });
  protected readonly advanceLabel = computed(() => {
    const s = this.session();
    if (s?.state === EstimationSessionState.PLACING) {
      return 'Start moving now';
    }
    if (s?.state === EstimationSessionState.MOVING) {
      return 'End moving now';
    }
    const last = (s?.round ?? 0) + 1 >= (s?.settings.rounds ?? 1);
    return last ? 'End the last round now' : 'End this round now';
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.sessionId();
      const lease = untracked(() => this.estimation.acquire(id));
      this.lease.set(lease);
      onCleanup(() => this.estimation.release(id));
    });
  }

  @WithSpan('EstimationPanel.advance')
  protected async advance(): Promise<void> {
    const s = this.session();
    if (s && this.canAdvance()) {
      await this.run(async () => {
        await this.estimation.advance(s.id, s.state, s.round);
      });
    }
  }

  @WithSpan('EstimationPanel.cancel')
  protected async cancel(): Promise<void> {
    const s = this.session();
    if (!s || !this.canCancel()) {
      return;
    }
    if (!this.confirmCancel()) {
      this.confirmCancel.set(true);
      return;
    }
    this.confirmCancel.set(false);
    await this.run(async () => {
      await this.estimation.cancel(s.id);
    });
  }

  @WithSpan('EstimationPanel.keep')
  protected keep(): void {
    this.confirmCancel.set(false);
  }

  @WithSpan('EstimationPanel.close')
  protected close(): void {
    this.closed.emit();
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.message.set(undefined);
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PLANNING_SESSION_WRONG_STATE') {
        this.lease()?.refresh();
      }
      this.message.set(
        error instanceof ApiError ? this.messages.text(error.problem) : 'Something went wrong.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
