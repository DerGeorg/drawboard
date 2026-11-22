import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, EstimationSession } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { BoardDoc } from '@apps/drawboard-engine';
import { all, buttonByLabel, buttonByText, textOf } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../../test/http-testing';
import { SESSION_ID, aMagicSession, aSession } from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { EstimationPanel, clock } from './estimation-panel';

const SESSION = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions/${SESSION_ID}`;

describe('EstimationPanel', () => {
  let fixture: ComponentFixture<EstimationPanel>;
  let board: BoardDoc | undefined;
  let engine: BoardEngine;
  let estimation: BoardEstimation;
  let closes: number;

  async function render(first: EstimationSession | 'gone'): Promise<void> {
    const fake = provideFakeAuth();
    fake.auth.signIn('alice');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    board = new BoardDoc();
    engine = new BoardEngine(document.createElement('div'), board);
    estimation = TestBed.inject(BoardEstimation);
    estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
    await settle();
    expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`, 'list').flush({
      items: [],
    });
    closes = 0;
    fixture = TestBed.createComponent(EstimationPanel, {
      bindings: [
        inputBinding('engine', () => engine),
        inputBinding('sessionId', () => SESSION_ID),
        outputBinding('closed', () => closes++),
      ],
    });
    await fixture.whenStable();
    expect(textOf(fixture), 'loading').toContain('Loading the session');
    await settle();
    const req = expectRequest('GET', SESSION, 'poll');
    if (first === 'gone') {
      req.flush(
        { code: 'PLANNING_SESSION_NOT_FOUND', status: 404, title: 'Not found' },
        problemResponse(404, 'Not Found'),
      );
    } else {
      req.flush(first, { headers: { ETag: `W/"${first.version}"` } });
    }
    await settle();
    await fixture.whenStable();
  }

  afterEach(() => {
    if (!board) {
      return; // a pure function test: nothing rendered
    }
    fixture.destroy();
    TestBed.inject(HttpTestingController).match(() => true);
    engine.destroy();
    board.destroy();
    board = undefined;
  });

  describe('states and controls', () => {
    it('when the session is in its lobby then the lobby shows and the panel takes the right side', async () => {
      await render(aSession());

      expect(all(fixture, 'drawboard-estimation-lobby').length, 'lobby').toBe(1);
      expect(textOf(fixture), 'title and mode').toContain('Rotation');
      expect(textOf(fixture), 'title').toContain('Sprint 42');
      expect(all(fixture, '[data-testid=countdown]').length, 'no deadline').toBe(0);
      expect(estimation.leaseCount, 'one lease').toBe(1);

      buttonByLabel(fixture, 'Close the estimation session').click();
      expect(closes, 'closed').toBe(1);
      fixture.destroy();
      expect(estimation.leaseCount, 'released with the panel').toBe(0);
    });

    it('when a round runs then the countdown and the round show, and the moderator ends it with the expected state', async () => {
      await render(
        aSession({
          state: 'ROTATING',
          round: 0,
          serverTime: '2026-11-19T10:00:00Z',
          phaseEndsAt: '2026-11-19T10:01:05Z',
        }),
      );

      expect(textOf(fixture), 'round').toContain('Round 1 of 2');
      expect(all(fixture, 'drawboard-rotation-panel').length, 'my cards').toBe(1);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid=countdown]')
          ?.textContent,
        'countdown by the server clock',
      ).toMatch(/1:0[45]/);
      buttonByText(fixture, 'End this round now').click();
      await settle();
      const req = expectRequest('POST', `${SESSION}/advance`, 'advance');
      expect(req.request.body, 'expected state and round (E14)').toEqual({
        state: 'ROTATING',
        round: 0,
      });
      req.flush(aSession({ state: 'ROTATING', round: 1, version: 3 }));
      await settle();
      await fixture.whenStable();
      expect(textOf(fixture), 'next round').toContain('Round 2 of 2');
      expect(buttonByText(fixture, 'End the last round now'), 'last').toBeTruthy();
    });

    it('when the phase moved on in between then the 409 says so and the session is read again', async () => {
      await render(aSession({ state: 'ROTATING', round: 0 }));

      buttonByText(fixture, 'End this round now').click();
      await settle();
      expectRequest('POST', `${SESSION}/advance`, 'advance').flush(
        { code: 'PLANNING_SESSION_WRONG_STATE', status: 409, title: 'Conflict' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'message').toContain('The session has moved on');
      expectRequest('GET', SESSION, 'read again').flush(aSession({ state: 'REVIEW', version: 4 }));
      await settle();
      await fixture.whenStable();
      expect(all(fixture, 'drawboard-estimation-review').length, 'the review').toBe(1);
    });

    it('when the moderator cancels then it asks once and cancels on yes', async () => {
      await render(aSession());

      buttonByText(fixture, 'Cancel session').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'asks').toContain('Cancel and delete all values?');
      buttonByText(fixture, 'No').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Cancel session').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Yes, cancel').click();
      await settle();
      expectRequest('POST', `${SESSION}/cancel`, 'cancel').flush(
        aSession({ state: 'CANCELLED', version: 5 }),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'cancelled').toContain('This session was cancelled.');
      expect(all(fixture, '[data-testid=moderator-controls]').length, 'nothing to control').toBe(0);
    });

    it('when someone else looks then there are no moderator controls', async () => {
      await render(aSession({ state: 'ROTATING', me: { seated: true, moderator: false } }));

      expect(all(fixture, '[data-testid=moderator-controls]').length, 'none').toBe(0);
    });

    it('when Magic places or moves cards then the board covers the canvas', async () => {
      await render(aMagicSession({ items: [], state: 'MOVING' }));

      expect(all(fixture, 'drawboard-magic-overlay').length, 'overlay').toBe(1);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('section')?.className,
        'wide',
      ).toContain('inset-x-3');
      expect(buttonByText(fixture, 'End moving now'), 'moderator ends moving').toBeTruthy();
    });

    it('when the session cannot be seen (any more) then the panel just says so', async () => {
      await render('gone');

      expect(textOf(fixture), 'gone').toContain('This session is not available (any more).');
    });
  });

  describe('clock', () => {
    it('when milliseconds are shown then minutes and seconds are rounded up', () => {
      expect(clock(125_000), 'two minutes five').toBe('2:05');
      expect(clock(400), 'under a second').toBe('0:01');
      expect(clock(0), 'zero').toBe('0:00');
    });
  });
});
