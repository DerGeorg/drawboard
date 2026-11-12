import { Component, computed, input, output, signal } from '@angular/core';

import type { ProviderState } from '../../../../../board-engine/collab/provider';
import { PeerPresence, safeColor } from '../../../../../board-engine/presence';
import { WithSpan } from '../../../../util/tracing';
import { Avatar } from '../../../shared/avatar/avatar';
import { Icon } from '../../../shared/icon/icon';
import { GuestBadge } from '../../guests/guest-badge/guest-badge';
import { BoardConnection } from '../board-connection/board-connection';

/** At most this many avatars are drawn, the rest is summarised as "+n". */
export const MAX_AVATARS = 4;

/** Brand colour of the signed-in user's own avatar (the server hands colours to the others). */
const SELF_COLOR = '#475569';

interface Person {
  key: string;
  name: string;
  color: string;
  /** `From.guest` of the server: shown as a badge, whatever the name says. */
  guest: boolean;
  /** The participant behind it (absent for yourself). */
  peer?: PeerPresence;
}

/**
 * The pill at the top right: who is on the board right now (name and colour from the server's
 * `From`, you first; every guest carries a Guest badge), the connection badge and the primary
 * Share button - for a guest the Guest badge with a Leave button instead. A click on someone's
 * avatar opens their menu (Miro-like): follow them, ask them to follow you (signed-in editors),
 * ignore their summons; "Bring everyone to me" asks all.
 */
@Component({
  selector: 'drawboard-board-participants',
  imports: [Avatar, BoardConnection, GuestBadge, Icon],
  templateUrl: './board-participants.html',
  host: { '(keydown.escape)': 'closeMenu()' },
})
export class BoardParticipants {
  /** The other participants (from the collaboration presence). */
  readonly peers = input<readonly PeerPresence[]>([]);
  /** The signed-in user; shown first. */
  readonly selfName = input<string>();
  /** The viewer is a guest: a Guest badge instead of the Share button, and they are marked as one. */
  readonly guest = input(false);
  readonly state = input<ProviderState>();
  /** Client id of the participant I follow. */
  readonly following = input<number | null>(null);
  /** I may summon (signed-in editor or owner). */
  readonly canPresent = input(false);
  /** `From.id` of the people whose summons I ignore. */
  readonly ignored = input<ReadonlySet<string>>(new Set());
  readonly share = output();
  readonly follow = output<PeerPresence>();
  readonly stopFollowing = output();
  /** Ask these participants to follow me ('all': everyone). */
  readonly summon = output<'all' | number[]>();
  readonly ignore = output<PeerPresence>();
  /** Summons of this person count again. */
  readonly unignore = output<PeerPresence>();

  /** Client id of the person whose menu is open; 'more' for the list of hidden people. */
  protected readonly menu = signal<number | 'more' | null>(null);

  private readonly people = computed<Person[]>(() => {
    const self = this.selfName();
    const others = this.peers().map((p) => ({
      key: `peer-${p.clientId}`,
      name: p.name,
      color: safeColor(p.color),
      guest: p.guest,
      peer: p,
    }));
    return self
      ? [{ key: 'self', name: `${self} (you)`, color: SELF_COLOR, guest: this.guest() }, ...others]
      : others;
  });

  protected readonly shown = computed(() => this.people().slice(0, MAX_AVATARS));
  protected readonly overflow = computed(() => Math.max(0, this.people().length - MAX_AVATARS));
  protected readonly hidden = computed(() => this.people().slice(MAX_AVATARS));
  /** The person whose menu is open (they may have left meanwhile). */
  protected readonly menuPeer = computed(() => {
    const open = this.menu();
    return typeof open === 'number' ? this.peers().find((p) => p.clientId === open) : undefined;
  });
  protected readonly overflowNames = computed(() =>
    this.people()
      .slice(MAX_AVATARS)
      .map((p) => p.name)
      .join(', '),
  );

  @WithSpan('BoardParticipants.toggleMenu')
  protected toggleMenu(open: number | 'more'): void {
    this.menu.update((now) => (now === open ? null : open));
  }

  @WithSpan('BoardParticipants.closeMenu')
  protected closeMenu(): void {
    this.menu.set(null);
  }

  @WithSpan('BoardParticipants.followPeer')
  protected followPeer(peer: PeerPresence): void {
    this.closeMenu();
    if (this.following() === peer.clientId) {
      this.stopFollowing.emit();
    } else {
      this.follow.emit(peer);
    }
  }

  @WithSpan('BoardParticipants.summonPeers')
  protected summonPeers(targets: 'all' | number[]): void {
    this.closeMenu();
    this.summon.emit(targets);
  }

  @WithSpan('BoardParticipants.ignorePeer')
  protected ignorePeer(peer: PeerPresence): void {
    this.closeMenu();
    this.ignore.emit(peer);
  }

  @WithSpan('BoardParticipants.unignorePeer')
  protected unignorePeer(peer: PeerPresence): void {
    this.closeMenu();
    this.unignore.emit(peer);
  }

  @WithSpan('BoardParticipants.openShare')
  protected openShare(): void {
    this.share.emit();
  }
}
