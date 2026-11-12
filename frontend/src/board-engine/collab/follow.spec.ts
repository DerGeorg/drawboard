import { PeerPresence } from '../presence';
import { ViewportState } from './awareness-state';
import {
  FollowController,
  FollowEnd,
  Following,
  REPEATED_STOP_WINDOW_MS,
  SUMMON_COOLDOWN_MS,
  maySummon,
} from './follow';

const SELF = 1;

function peer(clientId: number, extra: Partial<PeerPresence> = {}): PeerPresence {
  return {
    clientId,
    userId: `user-${clientId}`,
    name: `Person ${clientId}`,
    color: '#2563eb',
    guest: false,
    role: 'EDITOR',
    cursor: null,
    selection: [],
    viewport: { x: clientId * 100, y: 0, zoom: 1 },
    following: null,
    summon: null,
    ...extra,
  };
}

describe('FollowController', () => {
  let now: number;
  let allowed: boolean;
  let c: FollowController;
  let moves: ViewportState[];
  let ends: FollowEnd[];
  let states: (Following | null)[];

  beforeEach(() => {
    now = 1_000_000;
    allowed = true;
    c = new FollowController({ now: () => now, canSummon: () => allowed });
    moves = [];
    ends = [];
    states = [];
    c.viewport.on((v) => moves.push(v));
    c.ended.on((e) => ends.push(e));
    c.changed.on((f) => states.push(f));
  });
  afterEach(() => c.destroy());

  describe('following', () => {
    it('when a participant is followed then the camera goes to their viewport and tracks it', () => {
      const bob = peer(2);
      c.follow(bob);

      expect(c.following, 'following').toMatchObject({
        clientId: 2,
        mode: 'manual',
        name: 'Person 2',
      });
      expect(moves, 'first move').toEqual([{ x: 200, y: 0, zoom: 1 }]);

      c.update([{ ...bob, viewport: { x: 300, y: 10, zoom: 0.5 } }], SELF);
      c.update([{ ...bob, viewport: { x: 300, y: 10, zoom: 0.5 } }], SELF);

      expect(moves, 'tracked, unchanged viewport not repeated').toEqual([
        { x: 200, y: 0, zoom: 1 },
        { x: 300, y: 10, zoom: 0.5 },
      ]);
    });

    it('when the followed participant has no viewport yet then the camera waits for one', () => {
      const bob = peer(2, { viewport: null });
      c.follow(bob);
      expect(moves, 'nothing yet').toEqual([]);

      c.update([{ ...bob, viewport: { x: 1, y: 2, zoom: 2 } }], SELF);

      expect(moves, 'moved').toEqual([{ x: 1, y: 2, zoom: 2 }]);
    });

    it('when the user stops (own pan, zoom, Esc, Stop) then following ends without a notice reason', () => {
      c.follow(peer(2));

      c.stop();
      c.stop();

      expect(c.following, 'stopped').toBeNull();
      expect(ends, 'once').toEqual([{ reason: 'stopped' }]);
      expect(states, 'states').toEqual([expect.objectContaining({ clientId: 2 }), null]);
    });

    it('when the followed participant leaves then following ends with their name', () => {
      c.follow(peer(2));

      c.update([peer(3)], SELF);

      expect(c.following, 'stopped').toBeNull();
      expect(ends, 'notice').toEqual([{ reason: 'left', name: 'Person 2' }]);
    });

    it('when another participant is followed then the first one is replaced', () => {
      c.follow(peer(2));
      c.follow(peer(3));

      expect(c.following?.clientId, 'now').toBe(3);
    });
  });

  describe('summon', () => {
    const presenter = (id = 9, targets: 'all' | number[] = 'all'): PeerPresence =>
      peer(2, { summon: { id, targets } });

    it('when an editor summons everyone then this client follows them', () => {
      c.update([presenter()], SELF);

      expect(c.following, 'following').toMatchObject({ clientId: 2, mode: 'summoned' });
      expect(moves.length, 'camera moved').toBe(1);
    });

    it('when a summon names other clients only then it is not for us', () => {
      c.update([presenter(9, [5, 6])], SELF);

      expect(c.following, 'not following').toBeNull();
    });

    it('when a summon names us among others then we follow', () => {
      c.update([presenter(9, [5, SELF])], SELF);

      expect(c.following?.clientId, 'following').toBe(2);
    });

    it('when the sender may not summon (guest, viewer) then that summon id is decided for good', () => {
      allowed = false;
      c.update([presenter()], SELF);
      allowed = true;
      c.update([presenter()], SELF);

      expect(c.following, 'never').toBeNull();
    });

    it('when the summoned user stops then the same summon does not pull them back', () => {
      c.update([presenter()], SELF);
      c.stop();

      now += SUMMON_COOLDOWN_MS * 10;
      c.update([presenter()], SELF);

      expect(c.following, 'stays stopped').toBeNull();
    });

    it('when the presenter summons again within the cooldown then it is not honoured, after it it is', () => {
      c.update([presenter(9)], SELF);
      c.stop();

      now += SUMMON_COOLDOWN_MS - 1;
      c.update([presenter(10)], SELF);
      expect(c.following, 'within the cooldown').toBeNull();

      now += 2;
      c.update([presenter(11)], SELF);
      expect(c.following?.clientId, 'after the cooldown').toBe(2);
    });

    it('when a summon id was skipped by the cooldown then it is not honoured later either', () => {
      c.update([presenter(9)], SELF);
      c.stop();
      now += 1000;
      c.update([presenter(10)], SELF);

      now += SUMMON_COOLDOWN_MS;
      c.update([presenter(10)], SELF);

      expect(c.following, 'decided once').toBeNull();
    });

    it('when a sender is ignored then their summons are not honoured and a running one stops', () => {
      c.update([presenter(9)], SELF);
      c.ignore('user-2', 'Person 2');

      expect(c.following, 'stopped').toBeNull();
      expect(ends, 'reason').toEqual([{ reason: 'ignored', name: 'Person 2' }]);
      expect(c.isIgnored('user-2'), 'ignored').toBe(true);

      now += SUMMON_COOLDOWN_MS * 2;
      c.update([presenter(10)], SELF);
      expect(c.following, 'still ignored').toBeNull();
    });

    it('when ignoring someone I follow manually then following goes on', () => {
      c.follow(peer(2));

      c.ignore('user-2', 'Person 2');

      expect(c.following?.mode, 'manual stays').toBe('manual');
    });

    it('when the presenter ends the summon then summoned followers stop with a notice', () => {
      c.update([presenter()], SELF);

      c.update([peer(2)], SELF);

      expect(c.following, 'stopped').toBeNull();
      expect(ends, 'notice').toEqual([{ reason: 'presenting-ended', name: 'Person 2' }]);
    });

    it('when the presenter takes us off the target list then we stop', () => {
      c.update([presenter(9, [SELF, 5])], SELF);

      c.update([presenter(9, [5])], SELF);

      expect(c.following, 'stopped').toBeNull();
    });

    it('when following manually and the followed one ends a summon then following goes on', () => {
      c.follow(peer(2));

      c.update([peer(2)], SELF);

      expect(c.following?.clientId, 'still').toBe(2);
    });

    it('when a summoning presenter leaves then following stops with the left notice', () => {
      c.update([presenter()], SELF);

      c.update([], SELF);

      expect(ends, 'notice').toEqual([{ reason: 'left', name: 'Person 2' }]);
    });

    it('when the cooldown is per sender then another presenter may summon right away', () => {
      c.update([presenter(9)], SELF);
      c.stop();

      c.update([presenter(9), peer(3, { summon: { id: 4, targets: 'all' } })], SELF);

      expect(c.following?.clientId, 'second presenter').toBe(3);
    });

    it('when the name changes in the payload then the name shown still comes from the peer (From)', () => {
      c.update([{ ...presenter(), name: 'Bob (from server)' }], SELF);

      expect(c.following?.name, 'name').toBe('Bob (from server)');
    });
  });

  describe('summon rules', () => {
    const presenter = (id = 9, extra: Partial<PeerPresence> = {}): PeerPresence =>
      peer(2, { summon: { id, targets: 'all' }, ...extra });

    it('when the role is checked then only a signed-in OWNER or EDITOR may summon', () => {
      expect(maySummon({ guest: false, role: 'OWNER' }), 'owner').toBe(true);
      expect(maySummon({ guest: false, role: 'EDITOR' }), 'editor').toBe(true);
      expect(maySummon({ guest: false, role: 'COMMENTER' }), 'commenter').toBe(false);
      expect(maySummon({ guest: false, role: 'VIEWER' }), 'viewer').toBe(false);
      expect(maySummon({ guest: false, role: null }), 'absent role').toBe(false);
      expect(maySummon({ guest: true, role: 'EDITOR' }), 'guest with a role').toBe(false);
      expect(maySummon({ guest: true, role: 'OWNER' }), 'guest owner').toBe(false);
    });

    it('when no canSummon is given then the default rule decides', () => {
      const d = new FollowController({ now: () => now });
      const ended: FollowEnd[] = [];
      d.ended.on((e) => ended.push(e));

      d.update([presenter(1, { role: 'VIEWER' })], SELF);
      expect(d.following, 'viewer').toBeNull();
      d.update([presenter(2, { role: null })], SELF);
      expect(d.following, 'no role').toBeNull();
      d.update([presenter(3, { guest: true })], SELF);
      expect(d.following, 'guest').toBeNull();

      now += SUMMON_COOLDOWN_MS * 10;
      d.update([presenter(4, { role: 'OWNER' })], SELF);
      expect(d.following?.mode, 'owner').toBe('summoned');
      d.destroy();
    });

    it('when a peer rotates summon ids then only one entry per sender is kept', () => {
      for (let id = 1; id <= 1000; id++) {
        c.update([presenter(id)], SELF);
      }

      // private on purpose: the memory bound (one entry per sender) is the point of the test
      const decided = (c as unknown as { decided: Map<string, number> }).decided;
      expect(decided.size, 'entries').toBe(1);
      expect(decided.get('user-2'), 'latest id').toBe(1000);
    });

    it('when the same summon id is seen again then it is not decided twice', () => {
      allowed = false;
      c.update([presenter(9)], SELF);
      allowed = true;
      now += SUMMON_COOLDOWN_MS * 10;
      c.update([presenter(9)], SELF);

      expect(c.following, 'decided once').toBeNull();
    });

    it('when a new summon id comes after the cooldown then it is honoured', () => {
      c.update([presenter(9)], SELF);
      c.stop();

      now += SUMMON_COOLDOWN_MS + 1;
      c.update([presenter(10)], SELF);

      expect(c.following?.clientId, 'following').toBe(2);
    });

    it('when the second summon of a sender is stopped within two minutes then they are ignored', () => {
      c.update([presenter(9)], SELF);
      c.stop();
      expect(ends, 'first stop').toEqual([{ reason: 'stopped' }]);

      now += SUMMON_COOLDOWN_MS + 1;
      c.update([presenter(10)], SELF);
      now += 1000;
      c.stop();

      expect(ends.at(-1), 'second stop').toEqual({
        reason: 'auto-ignored',
        userId: 'user-2',
        name: 'Person 2',
      });
      expect(c.isIgnored('user-2'), 'ignored').toBe(true);

      now += SUMMON_COOLDOWN_MS * 2;
      c.update([presenter(11)], SELF);
      expect(c.following, 'next summon blocked').toBeNull();
    });

    it('when the second stop comes after the window then they are not ignored', () => {
      c.update([presenter(9)], SELF);
      c.stop();

      now += REPEATED_STOP_WINDOW_MS + 1;
      c.update([presenter(10)], SELF);
      c.stop();

      expect(ends, 'plain stops').toEqual([{ reason: 'stopped' }, { reason: 'stopped' }]);
      expect(c.isIgnored('user-2'), 'not ignored').toBe(false);

      now += SUMMON_COOLDOWN_MS + 1;
      c.update([presenter(11)], SELF);
      expect(c.following?.clientId, 'still honoured').toBe(2);
    });

    it('when a manual follow is stopped twice then nobody is ignored', () => {
      c.follow(peer(2));
      c.stop();
      c.follow(peer(2));
      c.stop();

      expect(ends, 'plain stops').toEqual([{ reason: 'stopped' }, { reason: 'stopped' }]);
      expect(c.isIgnored('user-2'), 'not ignored').toBe(false);
    });

    it('when a sender is allowed again then a later summon id is honoured', () => {
      c.update([presenter(9)], SELF);
      c.ignore('user-2', 'Person 2');
      expect(c.isIgnored('user-2'), 'ignored').toBe(true);

      c.unignore('user-2');
      now += SUMMON_COOLDOWN_MS + 1;
      c.update([presenter(10)], SELF);

      expect(c.isIgnored('user-2'), 'not ignored').toBe(false);
      expect(c.following?.clientId, 'following').toBe(2);
    });

    it('when the presenter role drops to viewer during a summon then following ends with the notice', () => {
      const d = new FollowController({ now: () => now });
      const ended: FollowEnd[] = [];
      d.ended.on((e) => ended.push(e));
      d.update([presenter(9)], SELF);
      expect(d.following?.mode, 'following').toBe('summoned');

      d.update([presenter(9, { role: 'VIEWER' })], SELF);

      expect(d.following, 'stopped').toBeNull();
      expect(ended, 'notice').toEqual([{ reason: 'presenting-ended', name: 'Person 2' }]);
      d.destroy();
    });
  });
});
