import { DestroyRef, Service, computed, effect, inject, signal, untracked } from '@angular/core';
import { BoardRole } from '@apps/drawboard-api';

import {
  MAX_SUMMON_TARGETS,
  SummonState,
  newSummonId,
  type PeerPresence,
} from '@apps/drawboard-engine';
import { FollowController, FollowEnd, Following } from '../../../../board-engine/collab/follow';
import type { BoardEngine } from '../../../../board-engine/engine';
import { Auth } from '../../../services/auth';
import { Toasts } from '../../../services/toasts';
import { BoardCollab } from './board-collab';

/**
 * Following and presenting on ONE open board (provided by BoardPage): follow a participant
 * (my camera tracks their viewport), "bring everyone to me" (summon all or chosen
 * participants), the participants following me, and the per-session "ignore summons from X".
 *
 * Who may summon: signed-in OWNER/EDITOR only. The sender side offers it only to them (from the
 * board metadata and the server's live role); the receiver decides on its own with the one rule
 * of `maySummon` - the server's `From` says no guest and role OWNER or EDITOR - the same for
 * guests and signed-in receivers, no member list is read (Fable 2026-11-11).
 */
@Service({ autoProvided: false })
export class BoardFollow {
  private readonly collab = inject(BoardCollab);
  private readonly auth = inject(Auth);
  private readonly toasts = inject(Toasts);

  /** The participant my camera follows, or null. */
  readonly following = signal<Following | null>(null);
  /** My summon while I present, or null. */
  readonly presenting = signal<SummonState | null>(null);
  /** `From.id` of the people whose summons I ignore (this session). */
  readonly ignored = signal<ReadonlySet<string>>(new Set());

  private readonly role = signal<BoardRole | undefined>(undefined);

  /**
   * Signed-in owners and editors may ask others to follow them; guests and viewers never. The
   * server's live role (`ROLE` frame) ends it at once, before the metadata is read again.
   */
  readonly canPresent = computed(() => {
    const live = this.collab.state()?.role;
    return (
      this.auth.guest() === null &&
      (this.role() === BoardRole.OWNER || this.role() === BoardRole.EDITOR) &&
      (live === undefined || live === 'OWNER' || live === 'EDITOR')
    );
  });

  /** The participants whose camera follows mine (they publish `following: <my client id>`). */
  readonly followers = computed(() => {
    const self = this.collab.clientId();
    return self === undefined ? [] : this.collab.peers().filter((p) => p.following === self);
  });

  private readonly controller = new FollowController();

  constructor() {
    this.controller.changed.on((f) => {
      this.following.set(f);
      this.collab.setLocalFields({ following: f?.clientId });
    });
    this.controller.ended.on((end) => this.notice(end));
    // the participants changed: follow, stop, accept a summon
    effect(() => {
      const peers = this.collab.peers();
      const self = this.collab.clientId();
      if (self !== undefined) {
        untracked(() => this.controller.update(peers, self));
      }
    });
    // a new document (version restored) has a new provider: publish our fields again
    effect(() => {
      if (this.collab.clientId() !== undefined) {
        untracked(() =>
          this.collab.setLocalFields({
            following: this.following()?.clientId,
            summon: this.presenting() ?? undefined,
          }),
        );
      }
    });
    // lost the right to present (role changed): the summon ends
    effect(() => {
      if (!this.canPresent() && untracked(this.presenting) !== null) {
        untracked(() => this.endPresenting());
      }
    });
    inject(DestroyRef).onDestroy(() => this.controller.destroy());
  }

  /** My role on the open board (from the board's metadata). */
  open(role: BoardRole | undefined): void {
    this.role.set(role);
  }

  /**
   * Connects the engine: the followed viewport moves its camera smoothly, any own pan or zoom
   * stops following. Returns the function that undoes it.
   */
  attach(engine: BoardEngine): () => void {
    const off = [
      this.controller.viewport.on((v) => engine.glideTo({ x: v.x, y: v.y }, v.zoom)),
      engine.navigated.on(() => this.controller.stop()),
    ];
    return () => off.forEach((o) => o());
  }

  follow(peer: PeerPresence): void {
    if (this.presenting()) {
      return; // a presenter leads; following someone would move everyone
    }
    if (peer.following !== null && peer.following === this.collab.clientId()) {
      // both cameras would chase each other
      this.toasts.success(`${peer.name} is following you - you cannot follow each other.`);
      return;
    }
    this.controller.follow(peer);
  }

  /** Stop button, Esc, own pan or zoom: local only, the presenter is not told. */
  stop(): void {
    this.controller.stop();
  }

  /** Summons from this person are ignored for the rest of the session (and following ends). */
  ignore(peer: PeerPresence): void {
    this.controller.ignore(peer.userId, peer.name);
    this.ignored.set(new Set([...this.ignored(), peer.userId]));
  }

  /** Summons from this person count again. */
  unignore(peer: PeerPresence): void {
    this.controller.unignore(peer.userId);
    const next = new Set(this.ignored());
    next.delete(peer.userId);
    this.ignored.set(next);
  }

  /**
   * Asks everyone (a new summon: everyone is asked again, within their cooldown), or adds the
   * given participants (client ids, at most 50 in all) to the running summon - its id stays, so
   * those who already stopped are not pulled back.
   */
  present(targets: 'all' | readonly number[]): void {
    if (!this.canPresent()) {
      return;
    }
    const running = this.presenting();
    if (targets !== 'all' && running?.targets === 'all') {
      return; // everyone is asked already
    }
    const here = new Set(this.collab.peers().map((p) => p.clientId));
    const before = running && running.targets !== 'all' ? running.targets : [];
    const chosen =
      targets === 'all'
        ? 'all'
        : [...new Set([...before, ...targets])]
            .filter((t) => here.has(t))
            .slice(0, MAX_SUMMON_TARGETS);
    if (chosen !== 'all' && chosen.length === 0) {
      return;
    }
    this.controller.stop();
    const id = running && targets !== 'all' ? running.id : newSummonId();
    const summon: SummonState = { id, targets: chosen };
    this.presenting.set(summon);
    this.collab.setLocalFields({ summon });
  }

  /** Ends presenting: the summoned followers stop and see a notice. */
  endPresenting(): void {
    this.presenting.set(null);
    this.collab.setLocalFields({ summon: undefined });
  }

  private notice(end: FollowEnd): void {
    if (end.reason === 'left') {
      this.toasts.success(`${end.name} left the board - you stopped following.`);
    } else if (end.reason === 'presenting-ended') {
      this.toasts.success(`${end.name} stopped presenting.`);
    } else if (end.reason === 'auto-ignored') {
      this.ignored.set(new Set([...this.ignored(), end.userId]));
      this.toasts.success(
        `${end.name}'s summons are now ignored. Undo it in their menu in the participant list.`,
      );
    }
  }
}
