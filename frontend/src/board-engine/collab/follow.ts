import {
  PeerPresence,
  Emitter,
  ViewportState,
  sameViewport,
  summons,
} from '@apps/drawboard-engine';

/** A summoned client honours at most one summon per sender in this time. */
export const SUMMON_COOLDOWN_MS = 15_000;

/** Stopping two summons of the same sender within this time ignores their summons. */
export const REPEATED_STOP_WINDOW_MS = 120_000;

/**
 * May this participant make others follow them? Exactly one rule, the same for every receiver,
 * guests included (Fable 2026-11-11): the server marks the sender as no guest and names the role
 * OWNER or EDITOR in `From`; anything else - an absent or unknown role too - is a no.
 */
export function maySummon(peer: Pick<PeerPresence, 'guest' | 'role'>): boolean {
  return !peer.guest && (peer.role === 'OWNER' || peer.role === 'EDITOR');
}

export interface Following {
  /** Yjs client id of the participant followed. */
  clientId: number;
  /** `From.id` of that participant. */
  userId: string;
  /** Their name from the server's `From` (never from the awareness payload). */
  name: string;
  color: string;
  /** `manual`: chosen in the participant menu; `summoned`: they asked us to follow them. */
  mode: 'manual' | 'summoned';
}

export interface FollowOptions {
  /** Milliseconds; tests pass a fake clock. */
  now?: () => number;
  /** Who may summon; the default is `maySummon`. */
  canSummon?: (peer: PeerPresence) => boolean;
  cooldownMs?: number;
}

/** Why following ended (the page shows a notice for the ones it did not cause itself). */
export type FollowEnd =
  | { reason: 'stopped' }
  | { reason: 'left'; name: string }
  | { reason: 'presenting-ended'; name: string }
  | { reason: 'ignored'; name: string }
  /** The second stop of this sender's summons within two minutes: their summons are ignored now. */
  | { reason: 'auto-ignored'; userId: string; name: string };

/**
 * Following another participant, and being summoned (no Angular, no DOM). The host feeds it the
 * peers (`update`) and its own client id, and moves the camera on `viewport`; any own pan, zoom
 * or Esc ends it (`stop`). Rules for a summon - a peer's `summon` that names us or everyone:
 *
 * - decided once per (sender, summon id): stopping is local and final for that summon; only the
 *   sender's latest summon id is kept, so a peer rotating ids cannot grow the memory;
 * - never from a sender this session ignores (keyed by `From.id`), never when `canSummon` says
 *   no (guests, viewers, commenters, an unknown role);
 * - at most one honoured summon per sender per `cooldownMs` (an id change does not reset it);
 * - stopping two summons of the same sender within `REPEATED_STOP_WINDOW_MS` ignores them;
 * - a summoned follow ends when the presenter's summon or their right to summon ends;
 * - the payload carries no text; names shown come from the server's `From`.
 */
export class FollowController {
  /** The participant followed now, or null. */
  readonly changed = new Emitter<Following | null>();
  /** Where the camera should go (the followed participant's centre and zoom). */
  readonly viewport = new Emitter<ViewportState>();
  /** Following ended. */
  readonly ended = new Emitter<FollowEnd>();

  private current: Following | null = null;
  private lastViewport: ViewportState | null = null;
  /** The latest summon id decided per sender (`From.id`): one entry per person. */
  private readonly decided = new Map<string, number>();
  /** When a summon of each sender (`From.id`) was last honoured. */
  private readonly honouredAt = new Map<string, number>();
  /** When I last stopped a summon of each sender. */
  private readonly stoppedAt = new Map<string, number>();
  private readonly ignoredUsers = new Set<string>();
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly canSummon: (peer: PeerPresence) => boolean;

  constructor(options: FollowOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.cooldownMs = options.cooldownMs ?? SUMMON_COOLDOWN_MS;
    this.canSummon = options.canSummon ?? maySummon;
  }

  get following(): Following | null {
    return this.current;
  }

  /** Starts following `peer` (from the participant menu). */
  follow(peer: PeerPresence): void {
    this.start(peer, 'manual');
  }

  /**
   * Own pan, zoom, Esc or the Stop button: ends following, the presenter is not told. The second
   * stop of the same sender's summons within two minutes ignores that sender from then on.
   */
  stop(): void {
    const current = this.current;
    if (!current) {
      return;
    }
    if (current.mode === 'summoned') {
      const last = this.stoppedAt.get(current.userId);
      this.stoppedAt.set(current.userId, this.now());
      if (last !== undefined && this.now() - last <= REPEATED_STOP_WINDOW_MS) {
        this.ignoredUsers.add(current.userId);
        this.end({ reason: 'auto-ignored', userId: current.userId, name: current.name });
        return;
      }
    }
    this.end({ reason: 'stopped' });
  }

  /** Summons from this person are ignored for the rest of the session. */
  ignore(userId: string, name: string): void {
    this.ignoredUsers.add(userId);
    if (this.current?.userId === userId && this.current.mode === 'summoned') {
      this.end({ reason: 'ignored', name });
    }
  }

  /** Summons from this person count again (their next summon id is decided anew). */
  unignore(userId: string): void {
    this.ignoredUsers.delete(userId);
    this.stoppedAt.delete(userId);
  }

  isIgnored(userId: string): boolean {
    return this.ignoredUsers.has(userId);
  }

  /** The participants changed (presence from the provider); `self` is our own client id. */
  update(peers: readonly PeerPresence[], self: number): void {
    this.acceptSummon(peers, self);
    const current = this.current;
    if (!current) {
      return;
    }
    const target = peers.find((p) => p.clientId === current.clientId);
    if (!target) {
      this.end({ reason: 'left', name: current.name });
      return;
    }
    if (current.mode === 'summoned' && (!summons(target.summon, self) || !this.canSummon(target))) {
      this.end({ reason: 'presenting-ended', name: current.name });
      return;
    }
    this.moveTo(target.viewport);
  }

  destroy(): void {
    this.current = null;
    this.changed.clear();
    this.viewport.clear();
    this.ended.clear();
  }

  private acceptSummon(peers: readonly PeerPresence[], self: number): void {
    for (const peer of peers) {
      const summon = peer.summon;
      if (!summon || !summons(summon, self)) {
        continue;
      }
      if (this.decided.get(peer.userId) === summon.id) {
        continue;
      }
      this.decided.set(peer.userId, summon.id);
      const allowed = !this.ignoredUsers.has(peer.userId) && this.canSummon(peer);
      const last = this.honouredAt.get(peer.userId);
      if (!allowed || (last !== undefined && this.now() - last < this.cooldownMs)) {
        continue;
      }
      this.honouredAt.set(peer.userId, this.now());
      this.start(peer, 'summoned');
    }
  }

  private start(peer: PeerPresence, mode: Following['mode']): void {
    this.current = {
      clientId: peer.clientId,
      userId: peer.userId,
      name: peer.name,
      color: peer.color,
      mode,
    };
    this.lastViewport = null;
    this.changed.emit(this.current);
    this.moveTo(peer.viewport);
  }

  private moveTo(viewport: ViewportState | null): void {
    if (viewport && !sameViewport(viewport, this.lastViewport)) {
      this.lastViewport = viewport;
      this.viewport.emit(viewport);
    }
  }

  private end(why: FollowEnd): void {
    this.current = null;
    this.lastViewport = null;
    this.changed.emit(null);
    this.ended.emit(why);
  }
}
