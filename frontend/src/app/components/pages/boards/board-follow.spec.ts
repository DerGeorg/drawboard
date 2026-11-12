import { TestBed } from '@angular/core/testing';
import { BoardRole } from '@apps/drawboard-api';

import { BoardDoc } from '../../../../board-engine/model/board-doc';
import { BoardEngine } from '../../../../board-engine/engine';
import type { CollabRole } from '../../../../board-engine/collab/frames';
import type { PeerPresence } from '../../../../board-engine/presence';
import { Toasts } from '../../../services/toasts';
import { FakeAuth, provideFakeAuth } from '../../../test/fake-auth';
import { provideHttpTesting } from '../../../test/http-testing';
import { BoardCollab } from './board-collab';
import { BoardFollow } from './board-follow';
import { FakeBoardCollab } from './testing/fake-board-collab';

const BOARD = '0192aaaa-0000-7000-8000-00000000f011';
const SELF = 1;

function peer(clientId: number, extra: Partial<PeerPresence> = {}): PeerPresence {
  return {
    clientId,
    userId: `id-user${clientId}`,
    name: `Person ${clientId}`,
    color: '#2563eb',
    guest: false,
    role: 'EDITOR',
    cursor: null,
    selection: [],
    viewport: { x: 100, y: 200, zoom: 0.5 },
    following: null,
    summon: null,
    ...extra,
  };
}

describe('BoardFollow', () => {
  let auth: FakeAuth;
  let collab: FakeBoardCollab;
  let follow: BoardFollow;
  let toasts: Toasts;

  function setup(signedIn: 'user' | 'guest' = 'user', role: BoardRole = BoardRole.EDITOR): void {
    const fake = provideFakeAuth();
    auth = fake.auth;
    if (signedIn === 'user') {
      auth.signIn('alice', 'Alice');
    } else {
      auth.signInAsGuest({ name: 'Gina', role: 'EDITOR', kind: 'BOARD', id: BOARD });
    }
    TestBed.configureTestingModule({
      providers: [
        ...fake.providers,
        provideHttpTesting(),
        { provide: BoardCollab, useClass: FakeBoardCollab },
        BoardFollow,
      ],
    });
    collab = TestBed.inject(BoardCollab) as unknown as FakeBoardCollab;
    follow = TestBed.inject(BoardFollow);
    toasts = TestBed.inject(Toasts);
    follow.open(role);
    TestBed.tick();
  }

  const liveState = {
    status: 'synced' as const,
    role: 'EDITOR' as CollabRole | undefined,
    error: undefined,
    closeCode: undefined,
    reloadRequired: false,
  };
  const setPeers = (peers: PeerPresence[]): void => {
    collab.peers.set(peers);
    TestBed.tick();
  };
  const summoner = (id = 7, extra: Partial<PeerPresence> = {}): PeerPresence =>
    peer(2, { summon: { id, targets: 'all' }, ...extra });

  describe('following', () => {
    it('when a participant is followed then my awareness says so and the engine glides there', () => {
      setup();
      const container = document.createElement('div');
      const board = new BoardDoc();
      const engine = new BoardEngine(container, board);
      const glide = vi.spyOn(engine, 'glideTo');
      const off = follow.attach(engine);
      setPeers([peer(2)]);

      follow.follow(peer(2));

      expect(follow.following()?.clientId, 'following').toBe(2);
      expect(collab.setLocalFields, 'published').toHaveBeenLastCalledWith({ following: 2 });
      expect(glide, 'camera').toHaveBeenCalledWith({ x: 100, y: 200 }, 0.5);

      engine.zoomIn(); // an own zoom stops following
      expect(follow.following(), 'stopped').toBeNull();
      expect(collab.setLocalFields, 'unpublished').toHaveBeenLastCalledWith({
        following: undefined,
      });
      off();
      engine.destroy();
      board.destroy();
    });

    it('when the followed participant leaves then a notice says so', () => {
      setup();
      const success = vi.spyOn(toasts, 'success');
      setPeers([peer(2)]);
      follow.follow(peer(2));

      setPeers([]);

      expect(follow.following(), 'stopped').toBeNull();
      expect(success, 'notice').toHaveBeenCalledWith(
        'Person 2 left the board - you stopped following.',
      );
    });
  });

  describe('presenting', () => {
    it('when an editor brings everyone then a summon for all is published, End removes it', () => {
      setup();
      setPeers([peer(2), peer(3)]);

      follow.present('all');

      const summon = follow.presenting();
      expect(summon?.targets, 'all').toBe('all');
      expect(collab.setLocalFields, 'published').toHaveBeenLastCalledWith({ summon });

      follow.endPresenting();
      expect(follow.presenting(), 'ended').toBeNull();
      expect(collab.setLocalFields, 'removed').toHaveBeenLastCalledWith({ summon: undefined });
    });

    it('when chosen participants are added one by one then the summon keeps its id and grows', () => {
      setup();
      setPeers([peer(2), peer(3)]);

      follow.present([2]);
      const first = follow.presenting();
      follow.present([3, 99]);

      expect(follow.presenting()?.targets, 'targets (99 is not here)').toEqual([2, 3]);
      expect(follow.presenting()?.id, 'same id').toBe(first?.id);
    });

    it('when everyone is asked again then the summon gets a new id', () => {
      setup();
      setPeers([peer(2)]);
      follow.present('all');
      const first = follow.presenting()?.id;

      follow.present('all');
      follow.present([2]); // already included

      expect(follow.presenting()?.id, 'new id').not.toBe(first);
      expect(follow.presenting()?.targets, 'still all').toBe('all');
    });

    it('when the user is a viewer or a guest then they cannot present', () => {
      setup('user', BoardRole.VIEWER);
      setPeers([peer(2)]);
      follow.present('all');
      expect(follow.canPresent(), 'viewer').toBe(false);
      expect(follow.presenting(), 'viewer').toBeNull();

      TestBed.resetTestingModule();
      setup('guest', BoardRole.EDITOR);
      setPeers([peer(2)]);
      follow.present('all');
      expect(follow.canPresent(), 'guest').toBe(false);
      expect(follow.presenting(), 'guest').toBeNull();
    });

    it('when the role drops while presenting then the summon ends', () => {
      setup();
      setPeers([peer(2)]);
      follow.present('all');

      follow.open(BoardRole.COMMENTER);
      TestBed.tick();

      expect(follow.presenting(), 'ended').toBeNull();
    });

    it('when the live role becomes viewer then canPresent turns false and the summon ends', () => {
      setup();
      setPeers([peer(2)]);
      follow.present('all');
      expect(follow.canPresent(), 'editor').toBe(true);

      collab.state.set({ ...liveState, role: 'VIEWER' });
      TestBed.tick();

      expect(follow.canPresent(), 'viewer').toBe(false);
      expect(follow.presenting(), 'ended').toBeNull();
    });

    it('when the live role is owner or not known yet then canPresent follows the board role', () => {
      setup();
      expect(follow.canPresent(), 'no live role').toBe(true);

      collab.state.set({ ...liveState, role: 'OWNER' });
      TestBed.tick();

      expect(follow.canPresent(), 'owner').toBe(true);
    });

    it('when others follow me then they are listed as followers', () => {
      setup();

      setPeers([peer(2, { following: SELF }), peer(3, { following: 2 })]);

      expect(
        follow.followers().map((p) => p.clientId),
        'followers',
      ).toEqual([2]);
    });
  });

  describe('being summoned (receiver rules)', () => {
    it('when a signed-in editor or owner summons then I follow, signed in or as a guest', () => {
      for (const receiver of ['user', 'guest'] as const) {
        for (const role of ['EDITOR', 'OWNER'] as CollabRole[]) {
          TestBed.resetTestingModule();
          setup(receiver);
          setPeers([summoner(7, { role })]);

          expect(follow.following(), `${receiver} follows ${role}`).toMatchObject({
            clientId: 2,
            mode: 'summoned',
          });
        }
      }
    });

    it('when the summoner is a viewer, commenter or has no role then a guest receiver refuses', () => {
      for (const role of ['VIEWER', 'COMMENTER', null] as (CollabRole | null)[]) {
        TestBed.resetTestingModule();
        setup('guest');
        setPeers([summoner(7, { role })]);

        expect(follow.following(), `guest receiver, sender ${role}`).toBeNull();
      }
    });

    it('when the summoner is a viewer, commenter or has no role then a signed-in receiver refuses', () => {
      for (const role of ['VIEWER', 'COMMENTER', null] as (CollabRole | null)[]) {
        TestBed.resetTestingModule();
        setup('user');
        setPeers([summoner(7, { role })]);

        expect(follow.following(), `signed-in receiver, sender ${role}`).toBeNull();
      }
    });

    it('when the summoner is a guest then nothing happens, even with an editor role', () => {
      setup();
      setPeers([summoner(7, { guest: true })]);

      expect(follow.following(), 'not following').toBeNull();
    });

    it('when I ignore the presenter then their next summon is not followed', () => {
      setup('guest');
      setPeers([summoner(7)]);
      follow.ignore(summoner());

      expect(follow.following(), 'stopped').toBeNull();
      expect(follow.ignored().has('id-user2'), 'ignored').toBe(true);
      setPeers([summoner(8)]);
      expect(follow.following(), 'still not').toBeNull();
    });

    it('when I allow their summons again then a later summon is followed', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        setup('guest');
        setPeers([summoner(7)]);
        follow.ignore(summoner());

        follow.unignore(summoner());

        expect(follow.ignored().has('id-user2'), 'not ignored').toBe(false);
        vi.advanceTimersByTime(20_000); // past the cooldown of the summon honoured before
        setPeers([summoner(8)]);
        expect(follow.following()?.mode, 'summoned').toBe('summoned');
      } finally {
        vi.useRealTimers();
      }
    });

    it('when the presenter ends then a notice says so', () => {
      setup('guest');
      const success = vi.spyOn(toasts, 'success');
      setPeers([summoner()]);

      setPeers([peer(2)]);

      expect(success, 'notice').toHaveBeenCalledWith('Person 2 stopped presenting.');
    });

    it('when the second summon of a presenter is stopped within two minutes then they are ignored with a notice', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        setup('guest');
        const success = vi.spyOn(toasts, 'success');
        setPeers([summoner(7)]);
        follow.stop();
        expect(follow.ignored().size, 'one stop only').toBe(0);

        vi.advanceTimersByTime(20_000); // past the cooldown of a summon
        setPeers([summoner(8)]);
        expect(follow.following()?.mode, 'second summon honoured').toBe('summoned');
        follow.stop();

        expect(follow.ignored().has('id-user2'), 'ignored').toBe(true);
        expect(success, 'notice').toHaveBeenCalledWith(
          "Person 2's summons are now ignored. Undo it in their menu in the participant list.",
        );
        vi.advanceTimersByTime(20_000);
        setPeers([summoner(9)]);
        expect(follow.following(), 'next summon refused').toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('following each other', () => {
    it('when the person already follows me then I cannot follow them and a notice says so', () => {
      setup();
      const success = vi.spyOn(toasts, 'success');
      setPeers([peer(2, { following: SELF })]);

      follow.follow(peer(2, { following: SELF }));

      expect(follow.following(), 'not following').toBeNull();
      expect(success, 'notice').toHaveBeenCalledWith(
        'Person 2 is following you - you cannot follow each other.',
      );
    });

    it('when the person follows someone else then I can follow them', () => {
      setup();
      setPeers([peer(2, { following: 3 })]);

      follow.follow(peer(2, { following: 3 }));

      expect(follow.following()?.clientId, 'following').toBe(2);
    });
  });
});
