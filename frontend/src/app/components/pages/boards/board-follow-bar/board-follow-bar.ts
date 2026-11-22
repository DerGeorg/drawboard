import { Component, computed, input, output } from '@angular/core';

import { type SummonState, PeerPresence, safeColor } from '@apps/drawboard-engine';
import type { Following } from '../../../../../board-engine/collab/follow';
import { WithSpan } from '../../../../util/tracing';

/** At most this many follower names are spelled out, the rest is "+n". */
export const MAX_FOLLOWER_NAMES = 3;

/**
 * Following and presenting, made visible (Miro-like): while my camera follows someone, a frame
 * in their colour around the canvas and "Following X" (or "X is presenting - you're following")
 * with Stop, and Esc stops too; while I present, "You are presenting - n following" with End.
 * Names come from the server's `From` only.
 */
@Component({
  selector: 'drawboard-board-follow-bar',
  templateUrl: './board-follow-bar.html',
  host: {
    class: 'pointer-events-none',
    '(document:keydown.escape)': 'escape()',
  },
})
export class BoardFollowBar {
  readonly following = input<Following | null>(null);
  readonly presenting = input<SummonState | null>(null);
  /** The participants following me. */
  readonly followers = input<readonly PeerPresence[]>([]);
  readonly stop = output();
  readonly endPresenting = output();
  /** Ignore further summons of the presenter I follow. */
  readonly ignore = output<Following>();

  protected readonly color = computed(() => safeColor(this.following()?.color));
  protected readonly followerNames = computed(() => {
    const names = this.followers().map((p) => p.name);
    const shown = names.slice(0, MAX_FOLLOWER_NAMES).join(', ');
    return names.length > MAX_FOLLOWER_NAMES
      ? `${shown} +${names.length - MAX_FOLLOWER_NAMES}`
      : shown;
  });

  protected escape(): void {
    if (this.following()) {
      this.stopFollowing();
    }
  }

  @WithSpan('BoardFollowBar.stopFollowing')
  protected stopFollowing(): void {
    this.stop.emit();
  }

  @WithSpan('BoardFollowBar.end')
  protected end(): void {
    this.endPresenting.emit();
  }

  @WithSpan('BoardFollowBar.ignorePresenter')
  protected ignorePresenter(f: Following): void {
    this.ignore.emit(f);
  }
}
