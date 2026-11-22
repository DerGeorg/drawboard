import { WritableSignal, inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, EstimationSession } from '@apps/drawboard-api';

import { all, buttonByText, buttonTexts, textOf } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../../test/http-testing';
import {
  SEAT_BOB,
  SEAT_GINA,
  SEAT_ME,
  SESSION_ID,
  aMagicSession,
  aSeat,
  aSession,
} from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { EstimationLobby } from './estimation-lobby';

const SESSION = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions/${SESSION_ID}`;

describe('EstimationLobby', () => {
  let fixture: ComponentFixture<EstimationLobby>;
  let session: WritableSignal<EstimationSession>;

  async function render(
    value: EstimationSession,
    role: BoardRole = BoardRole.EDITOR,
  ): Promise<void> {
    const fake = provideFakeAuth();
    fake.auth.signIn('alice');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    TestBed.inject(BoardEstimation).open(SPRINT_BOARD_ID, role);
    await settle();
    expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`, 'list').flush({
      items: [],
    });
    session = signal(value);
    fixture = TestBed.createComponent(EstimationLobby, {
      bindings: [inputBinding('session', session)],
    });
    await fixture.whenStable();
  }

  function seatBoxes(): HTMLInputElement[] {
    return all<HTMLInputElement>(fixture, '[data-testid=lobby-seats] input[type=checkbox]');
  }

  describe('what was fixed at creation (E1, E6)', () => {
    it('when an anonymous Rotation session is shown then deck, timing, cards and the named limits are there', async () => {
      await render(aSession());

      const text = textOf(fixture);
      expect(text, 'deck').toContain('0, 1, 2, 3, 5, 8, 13, 21, ?, ☕');
      expect(text, 'timing').toContain('2 rounds of 120 s');
      expect(text, 'cards').toContain('Checkout');
      expect(text, 'E6: next holder').toContain('next holder of a card sees the previous value');
      expect(text, 'E6: first value').toContain('first value of a card can be told apart');
      expect(text, 'E6: small teams').toContain('small team people can guess');
      expect(text, 'E6: database admin').toContain('until the review starts');
      expect(text, 'F1: the board itself is visible').toContain(
        'What you select or look at on the board itself stays visible to the others',
      );
    });

    it('when the session is Magic and not anonymous then names are announced and movers never', async () => {
      await render(aMagicSession({ anonymous: false }));

      const text = textOf(fixture);
      expect(text, 'timing').toContain('60 s placing, 120 s moving; marked after 3 moves');
      expect(text, 'names').toContain('Names are shown in the review');
      expect(text, 'movers').toContain('Who moved a card is never shown');
    });
  });

  describe('join and leave', () => {
    it('when the caller has not joined then Join puts a seat, and Leave takes it back', async () => {
      await render(aSession({ me: { seated: false, moderator: false } }), BoardRole.COMMENTER);

      buttonByText(fixture, 'Join').click();
      await settle();
      expectRequest('PUT', `${SESSION}/seats/me`, 'join').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      session.set(aSession({ me: { seatId: SEAT_ME, seated: true, moderator: false } }));
      await fixture.whenStable();
      expect(textOf(fixture), 'own seat marked').toContain('you');
      buttonByText(fixture, 'Leave').click();
      await settle();
      expectRequest('DELETE', `${SESSION}/seats/me`, 'leave').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
    });

    it('when the session is full then the message says so', async () => {
      await render(aSession({ me: { seated: false, moderator: false } }), BoardRole.COMMENTER);

      buttonByText(fixture, 'Join').click();
      await settle();
      expectRequest('PUT', `${SESSION}/seats/me`, 'join').flush(
        { code: 'PLANNING_SESSION_FULL', status: 409, title: 'Full' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'message').toContain('This estimation session is full.');
    });

    it('when a member only views the board then they watch', async () => {
      await render(aSession({ me: { seated: false, moderator: false } }), BoardRole.VIEWER);

      expect(textOf(fixture), 'watching').toContain('You watch this session.');
      expect(buttonTexts(fixture), 'no join').not.toContain('Join');
      expect(seatBoxes().length, 'no picking').toBe(0);
    });
  });

  describe('start (C3, E7)', () => {
    it('when more people are picked than there are cards then start is refused with a reason', async () => {
      await render(aSession());

      expect(seatBoxes().length, 'one box per seat').toBe(3);
      expect(buttonByText(fixture, 'Start').disabled, 'three people, two cards').toBe(true);
      expect(textOf(fixture), 'reason').toContain('Pick at most 2 people');

      seatBoxes()[2]?.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(buttonByText(fixture, 'Start').disabled, 'two people now').toBe(false);
      buttonByText(fixture, 'Start').click();
      await settle();
      const req = expectRequest('POST', `${SESSION}/start`, 'start');
      expect(JSON.parse(JSON.stringify(req.request.body)), 'picked seats').toEqual({
        seatIds: [SEAT_ME, SEAT_BOB],
      });
      req.flush(aSession({ state: 'ROTATING', version: 2 }));
    });

    it('when fewer people than rounds or than two are picked then start waits', async () => {
      await render(
        aSession({
          settings: { rounds: 3, roundSeconds: 60, advanceWhenDone: false },
          items: [...aSession().items, { ...aSession().items[0]!, id: 'c', position: 2 }],
        }),
      );
      seatBoxes()[2]?.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(textOf(fixture), 'rounds').toContain('Pick at least 3 people');

      seatBoxes()[1]?.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(textOf(fixture), 'two at least').toContain('Pick at least 2 people');
    });

    it('when someone joins after the moderator unpicked a seat then the choice stays and the new seat is picked', async () => {
      await render(aSession({ seats: [aSeat(), aSeat({ id: SEAT_BOB, displayName: 'Bob' })] }));
      seatBoxes()[1]?.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      session.set(
        aSession({
          seats: [
            aSeat(),
            aSeat({ id: SEAT_BOB, displayName: 'Bob' }),
            aSeat({ id: SEAT_GINA, displayName: 'Gina', guest: true }),
          ],
        }),
      );
      await fixture.whenStable();

      expect(
        seatBoxes().map((b) => b.checked),
        'kept and added',
      ).toEqual([true, false, true]);
      expect(textOf(fixture), 'guest badge').toContain('guest');
    });
  });
});
