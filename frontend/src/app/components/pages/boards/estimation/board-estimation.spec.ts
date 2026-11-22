import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { BoardRole, EstimationSessionState, GrantRole } from '@apps/drawboard-api';

import { Toasts } from '../../../../services/toasts';
import { FakeAuth, provideFakeAuth } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../test/http-testing';
import {
  ITEM_A,
  ITEM_B,
  SEAT_BOB,
  SEAT_ME,
  SESSION_ID,
  aMagicSession,
  aSession,
  aSummary,
  anItem,
} from '../testing/estimation';
import { BoardEstimation, LIST_MIN_INTERVAL_MS } from './board-estimation';
import { MOVING_INTERVAL_MS } from './estimation-lease';

const SESSIONS = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`;
const SESSION = `${SESSIONS}/${SESSION_ID}`;

describe('BoardEstimation', () => {
  let estimation: BoardEstimation;
  let auth: FakeAuth;
  let http: HttpTestingController;

  function setUp(sign: (a: FakeAuth) => void = (a) => a.signIn('alice', 'Alice Admin')): void {
    const fake = provideFakeAuth();
    auth = fake.auth;
    sign(auth);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    estimation = TestBed.inject(BoardEstimation);
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

  async function list(items = [aSummary()]): Promise<void> {
    await pass();
    expectRequest('GET', SESSIONS, 'list active sessions').flush({ items });
    await pass();
  }

  /** Opens the board as alice (editor) with an empty list. */
  async function opened(role: BoardRole = BoardRole.EDITOR): Promise<void> {
    estimation.open(SPRINT_BOARD_ID, role);
    await list([]);
  }

  function sessionRequest(description: string): TestRequest {
    return expectRequest('GET', SESSION, description);
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  describe('access (E8, E13)', () => {
    it('when the role is known then access follows the contract', () => {
      setUp();
      const cases: [BoardRole, string][] = [
        [BoardRole.OWNER, 'create'],
        [BoardRole.EDITOR, 'create'],
        [BoardRole.COMMENTER, 'join'],
        [BoardRole.VIEWER, 'view'],
      ];
      for (const [role, access] of cases) {
        estimation.open(SPRINT_BOARD_ID, role);
        expect(estimation.access(), role).toBe(access);
      }
      http.match(() => true);
    });

    it('when a guest has a view link then nothing is ever asked; comment and edit links join', async () => {
      setUp((a) =>
        a.signInAsGuest({
          name: 'Gina',
          role: GrantRole.VIEWER,
          kind: 'BOARD',
          id: SPRINT_BOARD_ID,
        }),
      );
      estimation.open(SPRINT_BOARD_ID, BoardRole.VIEWER);
      await pass();
      expect(estimation.access(), 'view link').toBe('none');
      estimation.loadSessions();
      estimation.loadClosed();
      expect(await estimation.busyCards(), 'no hint either').toEqual(new Map());
      http.expectNone(() => true, 'no estimation call for a view link');

      for (const role of [GrantRole.COMMENTER, GrantRole.EDITOR]) {
        auth.signInAsGuest({ name: 'Gina', role, kind: 'BOARD', id: SPRINT_BOARD_ID });
        expect(estimation.access(), role).toBe('join');
        expect(estimation.isGuest(), 'a guest').toBe(true);
      }
    });
  });

  describe('the list of sessions', () => {
    it('when a board opens then its ACTIVE sessions are listed and the chip follows the server', async () => {
      setUp();
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await pass();
      const req = expectRequest('GET', SESSIONS, 'list');
      expect(req.request.params.get('state'), 'state=ACTIVE').toBe('ACTIVE');
      req.flush({
        items: [
          aSummary({ state: EstimationSessionState.ROTATING }),
          aSummary({ id: 'x', state: EstimationSessionState.DONE }),
        ],
      });
      await pass();

      expect(
        estimation.sessions().map((s) => s.id),
        'closed ones dropped',
      ).toEqual([SESSION_ID]);
      expect(estimation.inEstimation(), 'seated in a running session').toBe(true);
    });

    it('when the caller only joined a lobby or watches then there is no chip', async () => {
      setUp();
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([
        aSummary(),
        aSummary({
          id: 'y',
          state: EstimationSessionState.MOVING,
          me: { seated: false, moderator: false },
        }),
      ]);

      expect(estimation.inEstimation(), 'lobby and spectator').toBe(false);
    });

    it('when the list is asked again within 5 s then the call waits', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      setUp();
      await opened();

      estimation.loadSessions();
      estimation.loadSessions();
      http.expectNone(SESSIONS, 'throttled');
      await vi.advanceTimersByTimeAsync(LIST_MIN_INTERVAL_MS);
      await list([aSummary()]);
      expect(estimation.sessions().length, 'listed').toBe(1);
    });

    it('when the list is rate limited then it waits for Retry-After without a toast', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      setUp();
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await pass();
      expectRequest('GET', SESSIONS, 'list').flush(
        { code: 'TOO_MANY_REQUESTS', status: 429, title: 'Too many' },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '20' } },
      );

      await vi.advanceTimersByTimeAsync(19_000);
      http.expectNone(SESSIONS, 'waiting');
      await vi.advanceTimersByTimeAsync(1_000);
      await list([]);
      expect(TestBed.inject(Toasts).toasts(), 'no toast for a hint').toEqual([]);
    });

    it('when the list fails otherwise then nothing shows and nothing breaks', async () => {
      setUp();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await pass();
      expectRequest('GET', SESSIONS, 'list').flush(
        { code: 'BAD_GATEWAY', status: 502, title: 'Bad gateway' },
        { status: 502, statusText: 'Bad Gateway' },
      );
      await pass();

      expect(estimation.sessions(), 'empty').toEqual([]);
      expect(navigate, 'no error page').not.toHaveBeenCalled();
      expect(TestBed.inject(Toasts).toasts(), 'no toast').toEqual([]);
    });

    it('when a member asks for finished sessions then CLOSED is listed; a guest never asks', async () => {
      setUp();
      await opened();
      estimation.loadClosed();
      await pass();
      const req = expectRequest('GET', SESSIONS, 'closed');
      expect(req.request.params.get('state'), 'state=CLOSED').toBe('CLOSED');
      req.flush({ items: [aSummary({ state: EstimationSessionState.DONE })] });
      await pass();
      expect(estimation.closed()?.length, 'closed listed').toBe(1);

      auth.signInAsGuest({ name: 'G', role: GrantRole.EDITOR, kind: 'BOARD', id: SPRINT_BOARD_ID });
      estimation.loadClosed();
      await pass();
      http.expectNone(SESSIONS, 'guests get 403 for CLOSED, so they never ask');
    });

    it('when the cards of active sessions are asked then each session is read once', async () => {
      setUp();
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([aSummary(), aSummary({ id: 'other' })]);

      const busy = estimation.busyCards();
      await pass();
      sessionRequest('first session').flush(aSession());
      expectRequest('GET', `${SESSIONS}/other`, 'second session').flush(
        { code: 'PLANNING_SESSION_NOT_FOUND', status: 404, title: 'Not found' },
        { status: 404, statusText: 'Not Found' },
      );

      const map = await busy;
      expect([...map.keys()], 'ref keys of the readable one').toEqual([
        aSession().items[0]?.ref.blockId,
        `${aSession().items[1]?.ref.blockId}/${aSession().items[1]?.ref.cardId}`,
      ]);
      expect(map.get(aSession().items[0]?.ref.blockId ?? ''), 'session title').toBe('Sprint 42');
    });
  });

  describe('leases (one per session per tab)', () => {
    it('when a session is watched twice then one lease serves both and stops with the last', async () => {
      setUp();
      await opened();

      const a = estimation.acquire(SESSION_ID);
      const b = estimation.acquire(SESSION_ID);
      await pass();
      expect(a, 'shared').toBe(b);
      sessionRequest('one request').flush(aSession(), { headers: { ETag: 'W/"1"' } });
      await pass();
      expect(a.session()?.title, 'session').toBe('Sprint 42');

      estimation.release(SESSION_ID);
      expect(estimation.leaseCount, 'still one').toBe(1);
      estimation.release(SESSION_ID);
      expect(estimation.leaseCount, 'gone').toBe(0);
      expect(a.active, 'stopped').toBe(false);
    });

    it('when the session did not change then the next poll sends If-None-Match and a 304 keeps it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      setUp();
      await opened();
      const lease = estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(aSession({ version: 3 }), { headers: { ETag: 'W/"3"' } });
      await vi.advanceTimersByTimeAsync(2_000);

      const second = sessionRequest('second after 2 s');
      expect(second.request.headers.get('If-None-Match'), 'If-None-Match').toBe('W/"3"');
      second.flush(null, { status: 304, statusText: 'Not Modified' });
      await vi.advanceTimersByTimeAsync(0);

      expect(lease.session()?.version, 'kept').toBe(3);
      expect(TestBed.inject(Toasts).toasts(), 'no toast').toEqual([]);
      estimation.release(SESSION_ID);
    });

    it('when Magic is in MOVING then it polls every second, else every two', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      setUp();
      await opened();
      estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(
        aMagicSession({ state: EstimationSessionState.MOVING, phaseEndsAt: undefined }),
      );
      await vi.advanceTimersByTimeAsync(MOVING_INTERVAL_MS);
      sessionRequest('after one second').flush(aSession({ version: 2 }));
      await vi.advanceTimersByTimeAsync(MOVING_INTERVAL_MS);
      http.expectNone(SESSION, 'LOBBY: not after one second');
      await vi.advanceTimersByTimeAsync(MOVING_INTERVAL_MS);
      const later = sessionRequest('after two seconds');
      expect(later.request.method, 'polled again').toBe('GET');
      later.flush(aSession({ version: 2 }));
      estimation.release(SESSION_ID);
    });

    it('when the deadline passes then it polls by the server clock within the jitter', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        now: new Date('2026-11-19T10:00:05Z'), // the local clock runs 5 s ahead
      });
      vi.spyOn(Math, 'random').mockReturnValue(0);
      setUp();
      await opened();
      const lease = estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(
        aMagicSession({
          serverTime: '2026-11-19T10:00:00.000Z',
          phaseEndsAt: '2026-11-19T10:00:01.300Z',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lease.remainingMs(), 'by the server clock').toBe(1_300);

      await vi.advanceTimersByTimeAsync(1_200);
      http.expectNone(SESSION, 'before the deadline');
      await vi.advanceTimersByTimeAsync(150);
      sessionRequest('at the deadline, before the next tick').flush(
        aMagicSession({
          version: 2,
          state: EstimationSessionState.MOVING,
          serverTime: '2026-11-19T10:00:01.400Z',
          phaseEndsAt: '2026-11-19T10:02:01.300Z',
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lease.session()?.state, 'moving').toBe(EstimationSessionState.MOVING);
      expect(lease.remainingMs(), 'next deadline').toBe(119_900);
      estimation.release(SESSION_ID);
    });

    it('when the server rate limits the poll then it backs off for Retry-After', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      setUp();
      await opened();
      const lease = estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(
        { code: 'TOO_MANY_REQUESTS', status: 429, title: 'Too many' },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '7' } },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(lease.retrying(), 'retrying').toBe(true);

      await vi.advanceTimersByTimeAsync(6_900);
      http.expectNone(SESSION, 'still waiting');
      await vi.advanceTimersByTimeAsync(200);
      sessionRequest('after Retry-After').flush(aSession());
      await vi.advanceTimersByTimeAsync(0);
      expect(lease.retrying(), 'recovered').toBe(false);
      estimation.release(SESSION_ID);
    });

    it('when the poll was rate limited then refresh, pollSoon and a visible tab wait for Retry-After (Fable F2)', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      setUp();
      await opened();
      let hidden = false;
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
      const lease = estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(
        { code: 'TOO_MANY_REQUESTS', status: 429, title: 'Too many' },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '10' } },
      );
      await vi.advanceTimersByTimeAsync(0);

      lease.refresh();
      await vi.advanceTimersByTimeAsync(1_000);
      http.expectNone(SESSION, 'refresh waits');
      const placed = estimation.place(SESSION_ID, ITEM_A, '5', EstimationSessionState.PLACING);
      await pass();
      expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'the placement itself').flush(
        null,
        { status: 204, statusText: 'No Content' },
      );
      await placed;
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(4_000);
      http.expectNone(SESSION, 'a visible tab waits');
      vi.spyOn(Math, 'random').mockReturnValue(0);
      // pollSoon is what the deadline uses
      (lease as unknown as { poller: { pollSoon(j: number): void } }).poller.pollSoon(0);
      await vi.advanceTimersByTimeAsync(4_000);
      http.expectNone(SESSION, 'pollSoon waits');

      await vi.advanceTimersByTimeAsync(1_100);
      const after = sessionRequest('after 10 s');
      expect(after.request.method, 'polls once the wait is over').toBe('GET');
      after.flush(aSession());
      estimation.release(SESSION_ID);
    });

    it('when the tab is hidden then polling pauses and resumes when it is shown', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      setUp();
      await opened();
      let hidden = false;
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
      estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(aSession());
      await vi.advanceTimersByTimeAsync(0);

      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10_000);
      http.expectNone(SESSION, 'paused');
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await pass();
      const resumed = sessionRequest('resumed');
      expect(resumed.request.method, 'polls again once visible').toBe('GET');
      resumed.flush(aSession());
      estimation.release(SESSION_ID);
    });

    it('when the caller may not see the session (any more) then it leaves the list, without an error page', async () => {
      setUp();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([aSummary()]);
      const lease = estimation.acquire(SESSION_ID);
      await pass();

      sessionRequest('get').flush(
        { code: 'PLANNING_SESSION_NOT_FOUND', status: 404, title: 'Not found' },
        { status: 404, statusText: 'Not Found' },
      );
      await pass();

      expect(lease.end(), 'gone').toBe('gone');
      expect(estimation.sessions(), 'out of the list').toEqual([]);
      expect(navigate, 'no not-found page').not.toHaveBeenCalled();
      estimation.release(SESSION_ID);
    });

    it('when a polled session closes then it moves from the active to the finished list', async () => {
      setUp();
      estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
      await list([aSummary()]);
      estimation.loadClosed();
      await pass();
      expectRequest('GET', SESSIONS, 'closed').flush({ items: [] });
      const lease = estimation.acquire(SESSION_ID);
      await pass();

      sessionRequest('get').flush(aSession({ state: EstimationSessionState.DONE, version: 9 }));
      await pass();

      expect(estimation.sessions(), 'not active').toEqual([]);
      expect(
        estimation.closed()?.map((s) => s.id),
        'finished',
      ).toEqual([SESSION_ID]);
      expect(lease.active, 'a closed session is not polled again').toBe(false);
      estimation.release(SESSION_ID);
    });
  });

  describe('operations', () => {
    async function watched(session = aSession()): Promise<ReturnType<BoardEstimation['acquire']>> {
      await opened();
      const lease = estimation.acquire(SESSION_ID);
      await pass();
      sessionRequest('first').flush(session, { headers: { ETag: `W/"${session.version}"` } });
      await pass();
      return lease;
    }

    it('when a session is created then it is posted and listed at once', async () => {
      setUp();
      await opened();

      const created = estimation.create({
        mode: 'ROTATION',
        title: 'Sprint 42',
        deck: { kind: 'FIBONACCI' },
        items: [{ ref: { kind: 'STORY', blockId: 'b' }, title: 'Login' }],
        anonymous: true,
        settings: { rounds: 2, roundSeconds: 120 },
      });
      await pass();
      const req = expectRequest('POST', SESSIONS, 'create');
      expect(req.request.body.mode, 'body').toBe('ROTATION');
      req.flush(aSession());
      await created;

      expect(
        estimation.sessions().map((s) => s.id),
        'listed',
      ).toEqual([SESSION_ID]);
    });

    it('when the moderator starts then the seat ids go out as a JSON array and the answer is taken', async () => {
      setUp();
      const lease = await watched();

      const started = estimation.start(SESSION_ID, [SEAT_ME, SEAT_BOB, SEAT_ME]);
      await pass();
      const req = expectRequest('POST', `${SESSION}/start`, 'start');
      expect(
        Array.isArray((req.request.body as { seatIds: unknown }).seatIds),
        'an array in the body, not the generated Set (S2)',
      ).toBe(true);
      expect(JSON.parse(JSON.stringify(req.request.body)), 'array, each once').toEqual({
        seatIds: [SEAT_ME, SEAT_BOB],
      });
      req.flush(aSession({ state: EstimationSessionState.ROTATING, version: 2 }));
      await started;

      expect(lease.session()?.state, 'taken').toBe(EstimationSessionState.ROTATING);
      expect(estimation.sessions()[0]?.state, 'list follows').toBe(EstimationSessionState.ROTATING);
      estimation.release(SESSION_ID);
    });

    it('when the moderator advances then the expected state and round go along (E14)', async () => {
      setUp();
      await watched(aSession({ state: EstimationSessionState.ROTATING, round: 1, version: 4 }));

      const advanced = estimation.advance(SESSION_ID, EstimationSessionState.ROTATING, 1);
      await pass();
      const req = expectRequest('POST', `${SESSION}/advance`, 'advance');
      expect(req.request.body, 'expected state and round').toEqual({
        state: 'ROTATING',
        round: 1,
      });
      req.flush(aSession({ state: EstimationSessionState.REVIEW, round: 1, version: 5 }));
      await advanced;
      estimation.release(SESSION_ID);
    });

    it('when the caller places an own card in PLACING then it shows there although the version stays', async () => {
      setUp();
      const lease = await watched(
        aMagicSession({ items: [anItem({ mine: true }), anItem({ id: ITEM_B })] }),
      );

      const placed = estimation.place(SESSION_ID, ITEM_A, '5', EstimationSessionState.PLACING);
      await pass();
      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'place');
      expect(req.request.body, 'value and expected state').toEqual({
        value: '5',
        state: 'PLACING',
      });
      req.flush(null, { status: 204, statusText: 'No Content' });
      await placed;
      await pass();
      http.expectNone(SESSION, 'no extra poll after a placement (Fable F2)');

      const items = lease.session()?.items ?? [];
      expect(items[0]?.column, 'own card placed').toBe('5');
      expect(items[1]?.column, 'others untouched').toBeUndefined();

      const out = estimation.place(SESSION_ID, ITEM_A, null, EstimationSessionState.PLACING);
      await pass();
      expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'take out').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await out;
      expect(lease.session()?.items[0]?.column, 'out again').toBeUndefined();
      estimation.release(SESSION_ID);
    });

    it('when the caller enters a Rotation estimate then the round goes along and the entry shows', async () => {
      setUp();
      const lease = await watched(
        aSession({
          state: EstimationSessionState.ROTATING,
          round: 1,
          items: [anItem({ mine: true, currentValue: '3' })],
        }),
      );

      const entered = estimation.estimate(SESSION_ID, ITEM_A, {
        value: '5',
        reason: 'More work',
        round: 1,
      });
      await pass();
      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/estimate`, 'estimate');
      expect(req.request.body, 'value, reason, round').toEqual({
        value: '5',
        reason: 'More work',
        round: 1,
      });
      req.flush({ value: '5', reason: 'More work', kept: false });
      await entered;
      await pass();
      http.expectNone(SESSION, 'no extra poll after an entry (Fable F2)');

      expect(lease.session()?.items[0]?.myEntry?.value, 'own entry').toBe('5');
      estimation.release(SESSION_ID);
    });

    it('when join, leave, decide, finish and cancel are called then each hits its route', async () => {
      setUp();
      await watched(aSession({ state: EstimationSessionState.REVIEW }));
      const answer = { status: 204, statusText: 'No Content' };

      const join = estimation.join(SESSION_ID);
      await pass();
      expectRequest('PUT', `${SESSION}/seats/me`, 'join').flush(null, answer);
      await join;
      const leave = estimation.leave(SESSION_ID);
      await pass();
      expectRequest('DELETE', `${SESSION}/seats/me`, 'leave').flush(null, answer);
      await leave;
      http
        .match(SESSION)
        .forEach((r) => r.flush(null, { status: 304, statusText: 'Not Modified' }));
      const decide = estimation.decide(SESSION_ID, ITEM_A, '5');
      await pass();
      const d = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/decision`, 'decide');
      expect(d.request.body, 'decision').toEqual({ value: '5' });
      d.flush(null, answer);
      await decide;
      http
        .match(SESSION)
        .forEach((r) => r.flush(null, { status: 304, statusText: 'Not Modified' }));
      const finish = estimation.finish(SESSION_ID);
      await pass();
      expectRequest('POST', `${SESSION}/finish`, 'finish').flush(
        aSession({ state: EstimationSessionState.DONE, version: 9 }),
      );
      await finish;
      expect(estimation.sessions(), 'finished: out of the active list').toEqual([]);

      const cancel = estimation.cancel(SESSION_ID);
      await pass();
      expectRequest('POST', `${SESSION}/cancel`, 'cancel').flush(
        aSession({ state: EstimationSessionState.CANCELLED, version: 10 }),
      );
      await cancel;
      estimation.release(SESSION_ID);
    });

    it('when an operation fails with 401 then the usual handling runs and the call rejects', async () => {
      setUp();
      await opened();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');

      const join = estimation.join(SESSION_ID);
      await pass();
      expectRequest('PUT', `${SESSION}/seats/me`, 'join').flush(
        { code: 'UNAUTHORIZED', status: 401, title: 'Unauthorized' },
        { status: 401, statusText: 'Unauthorized' },
      );

      await expect(join, 'rejects').rejects.toMatchObject({ status: 401 });
      expect(auth.loginCalls.length + navigate.mock.calls.length, 'handled').toBeGreaterThan(0);
    });
  });
});
