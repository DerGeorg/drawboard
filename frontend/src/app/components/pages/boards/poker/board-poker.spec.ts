import { HttpTestingController } from '@angular/common/http/testing';
import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { BoardRole, GrantRole, PokerRoundState } from '@apps/drawboard-api';

import { STORY_TYPE, StoryModel, newStoryProps, BoardDoc } from '@apps/drawboard-engine';
import { Toasts } from '../../../../services/toasts';
import { FakeAuth, provideFakeAuth } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../test/http-testing';
import { ROUND_ID, STORY_BLOCK, aPokerRound } from '../testing/poker';
import { BoardPoker, LIST_MIN_INTERVAL_MS } from './board-poker';

const ROUNDS = `/api/boards/${SPRINT_BOARD_ID}/poker-rounds`;
const ROUND = `${ROUNDS}/${ROUND_ID}`;

describe('BoardPoker', () => {
  let poker: BoardPoker;
  let auth: FakeAuth;
  let http: HttpTestingController;

  function setUp(sign: (a: FakeAuth) => void = (a) => a.signIn('alice', 'Alice Admin')): void {
    const fake = provideFakeAuth();
    auth = fake.auth;
    sign(auth);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardPoker],
    });
    poker = TestBed.inject(BoardPoker);
    http = TestBed.inject(HttpTestingController);
  }

  /** Lets the async token interceptor pass (with fake timers too). */
  async function pass(): Promise<void> {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(1);
    } else {
      await settle();
    }
  }

  async function list(items = [aPokerRound()]): Promise<void> {
    await pass();
    expectRequest('GET', ROUNDS, 'list open rounds').flush({ items });
    await pass();
  }

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  describe('access (S1.8 M4)', () => {
    it('when the role is known then access follows the contract', async () => {
      setUp();
      const cases: [BoardRole, string][] = [
        [BoardRole.OWNER, 'start'],
        [BoardRole.EDITOR, 'start'],
        [BoardRole.COMMENTER, 'vote'],
        [BoardRole.VIEWER, 'view'],
      ];
      for (const [role, access] of cases) {
        poker.open(SPRINT_BOARD_ID, role);
        expect(poker.access(), role).toBe(access);
      }
    });

    it('when a guest has a comment or edit link then they vote; with a view link nothing at all', async () => {
      setUp((a) =>
        a.signInAsGuest({
          name: 'Gina',
          role: GrantRole.VIEWER,
          kind: 'BOARD',
          id: SPRINT_BOARD_ID,
        }),
      );
      poker.open(SPRINT_BOARD_ID, BoardRole.VIEWER);
      await pass();
      expect(poker.access(), 'view link').toBe('none');
      http.expectNone(() => true, 'no poker call for a view link');
      poker.loadOpenRounds();
      http.expectNone(() => true, 'not even on demand');

      auth.signInAsGuest({
        name: 'Gina',
        role: GrantRole.COMMENTER,
        kind: 'BOARD',
        id: SPRINT_BOARD_ID,
      });
      expect(poker.access(), 'comment link').toBe('vote');
      expect(poker.canFacilitate(aPokerRound()), 'never facilitates').toBe(false);
    });

    it('when a round is checked then only its facilitator (still editor) or the owner may close it', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);

      expect(poker.canFacilitate(aPokerRound({ facilitatorId: 'id-alice' })), 'own').toBe(true);
      expect(poker.canFacilitate(aPokerRound({ facilitatorId: 'id-bob' })), 'other').toBe(false);
      expect(poker.canFacilitate(aPokerRound({ facilitatorId: undefined })), 'unknown').toBe(false);
      poker.open(SPRINT_BOARD_ID, BoardRole.OWNER);
      expect(poker.canFacilitate(aPokerRound({ facilitatorId: 'id-bob' })), 'owner').toBe(true);
    });
  });

  describe('open rounds', () => {
    it('when a board opens then its OPEN rounds are listed and story cards learn about them', async () => {
      setUp();
      let changes = 0;
      poker.onChange(() => changes++);

      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await pass();
      const req = expectRequest('GET', ROUNDS, 'list');
      expect(req.request.params.get('state'), 'state=OPEN').toBe('OPEN');
      req.flush({
        items: [aPokerRound(), aPokerRound({ id: 'x', state: PokerRoundState.REVEALED })],
      });
      await pass();

      expect(
        poker.openRounds().map((r) => r.id),
        'only open',
      ).toEqual([ROUND_ID]);
      expect(poker.isOpen(STORY_BLOCK), 'card estimating').toBe(true);
      expect(poker.isOpen('other'), 'other card').toBe(false);
      expect(changes, 'listeners told').toBe(1);
    });

    it('when a card announces a round in the document then the list is read again, throttled', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);
      const board = new BoardDoc();
      const id = board.addBlock({
        type: STORY_TYPE,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        props: newStoryProps(),
        text: 'S',
      });
      poker.watch(board);

      new StoryModel(board, id).setPokerRound(ROUND_ID);
      http.expectNone(ROUNDS, 'not within 5 s');
      board.setGeometry(id, { x: 5 }); // no round change: nothing
      await vi.advanceTimersByTimeAsync(LIST_MIN_INTERVAL_MS);

      await list([aPokerRound({ storyBlockId: id })]);
      expect(poker.isOpen(id), 'known now').toBe(true);
      poker.watch(undefined);
      board.destroy();
    });

    it('when the list is rate limited then it waits for Retry-After', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await pass();
      expectRequest('GET', ROUNDS, 'list').flush(
        { code: 'TOO_MANY_REQUESTS', status: 429, title: 'Too many' },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '20' } },
      );

      await vi.advanceTimersByTimeAsync(19_000);
      http.expectNone(ROUNDS, 'waiting');
      await vi.advanceTimersByTimeAsync(1_000);
      await list([]);
      expect(TestBed.inject(Toasts).toasts(), 'no toast for a hint').toEqual([]);
    });
  });

  describe('polling (one poller per round per tab)', () => {
    it('when a round is watched twice then one poller serves both and stops with the last', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);

      const a = poker.acquire(ROUND_ID);
      const b = poker.acquire(ROUND_ID);
      await pass();
      expect(a, 'shared').toBe(b);
      expectRequest('GET', ROUND, 'one request').flush(aPokerRound(), {
        headers: { ETag: 'W/"1"' },
      });
      await pass();
      expect(a.round()?.version, 'round').toBe(1);

      poker.release(ROUND_ID);
      expect(poker.pollerCount, 'still one').toBe(1);
      poker.release(ROUND_ID);
      expect(poker.pollerCount, 'gone').toBe(0);
      expect(a.active, 'stopped').toBe(false);
    });

    it('when the round did not change then the 304 is no error: no toast, no error page', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      setUp();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);
      const poller = poker.acquire(ROUND_ID);
      await vi.advanceTimersByTimeAsync(0);
      expectRequest('GET', ROUND, 'first').flush(aPokerRound({ version: 3 }), {
        headers: { ETag: 'W/"3"' },
      });
      await vi.advanceTimersByTimeAsync(2_000);

      const second = expectRequest('GET', ROUND, 'second');
      expect(second.request.headers.get('If-None-Match'), 'If-None-Match').toBe('W/"3"');
      second.flush(null, { status: 304, statusText: 'Not Modified' });
      await vi.advanceTimersByTimeAsync(0);

      expect(poller.round()?.version, 'kept').toBe(3);
      expect(TestBed.inject(Toasts).toasts(), 'no toast').toEqual([]);
      expect(navigate, 'no error page').not.toHaveBeenCalled();
      poker.release(ROUND_ID);
    });

    it('when the round is gone then no error page shows either', async () => {
      setUp();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);
      const poller = poker.acquire(ROUND_ID);
      await pass();

      expectRequest('GET', ROUND, 'get').flush(
        { code: 'PLANNING_ROUND_NOT_FOUND', status: 404, title: 'Not found' },
        { status: 404, statusText: 'Not Found' },
      );
      await pass();

      expect(poller.end(), 'gone').toBe('gone');
      expect(navigate, 'no not-found page').not.toHaveBeenCalled();
      poker.release(ROUND_ID);
    });

    it('when the session ended during a poll then the usual 401 handling runs', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);
      poker.acquire(ROUND_ID);
      await pass();

      expectRequest('GET', ROUND, 'get').flush(null, { status: 401, statusText: 'Unauthorized' });
      await pass();

      expect(auth.loginCalls.length, 'sent to the login').toBe(1);
      poker.release(ROUND_ID);
    });
  });

  describe('operations', () => {
    it('when a round is created then it is posted and listed', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);

      const created = poker.create({
        storyBlockId: STORY_BLOCK,
        title: 'Login',
        deck: { kind: 'TSHIRT' },
      });
      await pass();
      const req = expectRequest('POST', ROUNDS, 'create');
      expect(req.request.body, 'body').toEqual({
        storyBlockId: STORY_BLOCK,
        title: 'Login',
        deck: { kind: 'TSHIRT' },
      });
      req.flush(aPokerRound(), { status: 201, statusText: 'Created' });

      expect((await created).id, 'created').toBe(ROUND_ID);
      expect(poker.isOpen(STORY_BLOCK), 'listed').toBe(true);
    });

    it('when a vote is cast then it is put and the poller keeps it', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.COMMENTER);
      await list([]);
      const poller = poker.acquire(ROUND_ID);
      await pass();
      expectRequest('GET', ROUND, 'get').flush(aPokerRound());

      const voted = poker.vote(ROUND_ID, '5');
      await pass();
      const req = expectRequest('PUT', `${ROUND}/vote`, 'vote');
      expect(req.request.body, 'body').toEqual({ value: '5' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      await voted;

      expect(poller.myVote(), 'own vote').toBe('5');
      http.match(ROUND).forEach((r) => r.flush(aPokerRound()));
      poker.release(ROUND_ID);
    });

    it('when a round is revealed or cancelled then it leaves the open list and the poller has it', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.OWNER);
      await list([aPokerRound(), aPokerRound({ id: 'r2', storyBlockId: 'b2' })]);
      const poller = poker.acquire(ROUND_ID);
      await pass();
      expectRequest('GET', ROUND, 'get').flush(aPokerRound());

      const revealed = poker.reveal(ROUND_ID);
      await pass();
      expectRequest('POST', `${ROUND}/reveal`, 'reveal').flush(
        aPokerRound({ state: PokerRoundState.REVEALED, version: 2 }),
      );
      await revealed;
      expect(poker.isOpen(STORY_BLOCK), 'out of the list').toBe(false);
      expect(poker.isOpen('b2'), 'the other stays').toBe(true);
      expect(poller.round()?.state, 'poller has it').toBe(PokerRoundState.REVEALED);

      const cancelled = poker.cancel('r2');
      await pass();
      expectRequest('POST', `${ROUNDS}/r2/cancel`, 'cancel').flush(
        aPokerRound({ id: 'r2', state: PokerRoundState.CANCELLED }),
      );
      await cancelled;
      expect(poker.openRounds(), 'empty').toEqual([]);
      poker.release(ROUND_ID);
    });

    it('when an operation fails then the ApiError reaches the caller without a toast', async () => {
      setUp();
      poker.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([]);

      const got = poker.get(ROUND_ID);
      await pass();
      expectRequest('GET', ROUND, 'get').flush(
        { code: 'PLANNING_ROUND_NOT_FOUND', status: 404, title: 'Not found' },
        { status: 404, statusText: 'Not Found' },
      );

      await expect(got, 'rejected').rejects.toMatchObject({ code: 'PLANNING_ROUND_NOT_FOUND' });
      expect(TestBed.inject(Toasts).toasts(), 'no toast').toEqual([]);
    });

    it('when no board was opened then operations refuse', async () => {
      setUp();

      expect(
        () => runInInjectionContext(TestBed.inject(Injector), () => poker.forget('x')),
        'harmless',
      ).not.toThrow();
      return expect(poker.vote(ROUND_ID, '1'), 'no board').rejects.toThrow('BoardPoker.open');
    });
  });
});
