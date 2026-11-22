import { HttpTestingController } from '@angular/common/http/testing';
import { WritableSignal, inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, EstimationSession } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { Toasts } from '../../../../../services/toasts';
import { all, buttonByText, textOf } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../../test/http-testing';
import {
  ITEM_A,
  ITEM_B,
  SEAT_BOB,
  SEAT_GINA,
  SESSION_ID,
  aBoardWithCards,
  aSeat,
  aSession,
  anItem,
} from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { RotationPanel } from './rotation-panel';

const SESSION = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions/${SESSION_ID}`;

describe('RotationPanel', () => {
  let fixture: ComponentFixture<RotationPanel>;
  let engine: BoardEngine;
  let ids: ReturnType<typeof aBoardWithCards>;
  let session: WritableSignal<EstimationSession>;

  async function render(value: (c: typeof ids) => EstimationSession): Promise<void> {
    const fake = provideFakeAuth();
    fake.auth.signIn('alice');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    ids = aBoardWithCards();
    engine = new BoardEngine(document.createElement('div'), ids.board);
    const estimation = TestBed.inject(BoardEstimation);
    estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
    await settle();
    expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`, 'list').flush({
      items: [],
    });
    localStorage.clear();
    session = signal(value(ids));
    fixture = TestBed.createComponent(RotationPanel, {
      bindings: [inputBinding('session', session), inputBinding('engine', () => engine)],
    });
    await fixture.whenStable();
  }

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    engine.destroy();
    ids.board.destroy();
  });

  /** Round 1 of 2: Alice holds the story card (previous value 3), Bob holds the kanban card. */
  function rotating(c: typeof ids, mine = {}): EstimationSession {
    return aSession({
      state: 'ROTATING',
      round: 1,
      seats: [
        aSeat({ done: false }),
        aSeat({ id: SEAT_BOB, displayName: 'Bob Builder', done: true }),
        aSeat({ id: SEAT_GINA, displayName: 'Gina', guest: true, seated: false }),
      ],
      items: [
        anItem({ ref: c.storyRef, mine: true, currentValue: '3', ...mine }),
        anItem({ id: ITEM_B, ref: c.cardRef, title: 'Checkout', position: 1 }),
      ],
    });
  }

  function heldCards(): HTMLElement[] {
    return all(fixture, '[data-testid=held-card]');
  }

  async function value(text: string): Promise<void> {
    const group = heldCards()[0]?.querySelector('[role=group]') as HTMLElement;
    const button = Array.from(group.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();
  }

  async function reason(text: string): Promise<void> {
    const input = (fixture.nativeElement as HTMLElement).querySelector(
      `#reason-${ITEM_A}`,
    ) as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  describe('my cards (E4)', () => {
    it('when a round runs then only the cards I hold show, live from the document, with the previous value and no author', async () => {
      await render((c) => rotating(c));

      expect(heldCards().length, 'one held card').toBe(1);
      const text = textOf(fixture);
      expect(text, 'live title').toContain('Login');
      expect(text, 'live description').toContain('As a user I sign in');
      expect(text, 'previous value').toContain('Previous estimate: 3');
      expect(text, 'the other card is not mine').not.toContain('Checkout');
      expect(heldCards()[0]?.textContent, 'no author of the previous value').not.toMatch(
        /Bob|Gina|Alice/,
      );
    });

    it('when the progress shows then it is per seat only, never per card (E3)', async () => {
      await render((c) => rotating(c));

      const progress = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid=rotation-progress]',
      ) as HTMLElement;
      expect(progress.textContent?.replace(/\s+/g, ' '), 'seats').toContain('1 of 2 done');
      expect(progress.querySelectorAll('li').length, 'one badge per seated seat').toBe(2);
      expect(textOf(fixture), 'no per-card counts').not.toMatch(
        /entries|estimated by|\d+ of \d+ cards/,
      );
    });

    it('when anything in the panel is used during a round then selection and camera never change (Fable F1)', async () => {
      await render((c) => rotating(c));
      engine.selection.set([ids.kanbanId]);
      const camera = { ...engine.camera };
      let moved = 0;
      engine.cameraChanged.on(() => moved++);
      let selected = 0;
      engine.selection.changed.on(() => selected++);

      // the title, description and previous value: plain text now, no jump to the block
      for (const el of all<HTMLElement>(
        fixture,
        '[data-testid=held-card] *:not(button):not(input):not([role=group])',
      )) {
        el.click();
      }
      await fixture.whenStable();
      await value('5');
      await reason('More work');
      buttonByText(fixture, 'Save').click();
      await settle();
      TestBed.inject(HttpTestingController)
        .match(() => true)
        .forEach((r) => r.flush({ value: '5', kept: false }));
      await settle();

      expect(
        all(fixture, '[data-testid=held-card] button[aria-label^=Show]').length,
        'no jump',
      ).toBe(0);
      expect(engine.selection.list(), 'selection untouched').toEqual([ids.kanbanId]);
      expect(selected, 'no selection change').toBe(0);
      expect({ ...engine.camera }, 'camera untouched').toEqual(camera);
      expect(moved, 'no camera change').toBe(0);
    });

    it('when the card is gone from the board then the stored title stands in', async () => {
      await render((c) => rotating(c, { ref: { kind: 'STORY', blockId: 'gone' } }));

      expect(textOf(fixture), 'stored copy').toContain('Login');
      expect(textOf(fixture), 'note').toContain('no longer on the board');
    });
  });

  describe('estimate (E14, reason rule)', () => {
    it('when the value differs from the previous one then a reason is required and the round goes along', async () => {
      await render((c) => rotating(c));

      await value('5');
      expect(buttonByText(fixture, 'Save').disabled, 'needs a reason').toBe(true);
      expect(textOf(fixture), 'hint').toContain('Say why you change the previous estimate.');
      await reason('  More work than it looks  ');
      buttonByText(fixture, 'Save').click();
      await settle();

      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/estimate`, 'estimate');
      expect(req.request.body, 'value, trimmed reason, expected round').toEqual({
        value: '5',
        reason: 'More work than it looks',
        round: 1,
      });
      req.flush({ value: '5', reason: 'More work than it looks', kept: false });
      await settle();
    });

    it('when the round moved on before the click then the entry is still for the round the card was shown in (S1)', async () => {
      await render((c) => rotating(c, { currentValue: undefined }));
      await value('8');

      // the next round arrives, but the click lands on the card as it was shown
      session.set({ ...rotating(ids, { currentValue: undefined }), round: 2 });
      buttonByText(fixture, 'Save').click();
      await settle();

      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/estimate`, 'estimate');
      expect(req.request.body, 'round 1, not 2').toEqual({ value: '8', round: 1 });
      req.flush(
        { code: 'PLANNING_SESSION_WRONG_STATE', status: 409, title: 'Conflict' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
    });

    it('when the previous value is picked again then no reason is asked and Keep sends it', async () => {
      await render((c) => rotating(c));

      await value('3');
      expect(all(fixture, `#reason-${ITEM_A}`).length, 'no reason field').toBe(0);
      buttonByText(fixture, 'Keep 3').click();
      await settle();

      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/estimate`, 'keep');
      expect(req.request.body, 'kept, no reason').toEqual({ value: '3', round: 1 });
      req.flush({ value: '3', kept: true });
      await settle();
      session.set(rotating(ids, { myEntry: { value: '3', kept: true } }));
      await fixture.whenStable();
      expect(textOf(fixture), 'saved').toContain('Kept: 3');
    });

    it('when the card has no previous value then any value goes without a reason', async () => {
      await render((c) => rotating(c, { currentValue: undefined }));

      expect(textOf(fixture), 'first').toContain('You are the first to estimate this card.');
      expect(textOf(fixture), 'no keep').not.toContain('Keep');
      await value('8');
      buttonByText(fixture, 'Save').click();
      await settle();

      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/estimate`, 'first');
      expect(req.request.body, 'no reason').toEqual({ value: '8', round: 1 });
      req.flush({ value: '8', kept: false });
      await settle();
    });

    it('when the reason is not one line of text then it is not sent', async () => {
      await render((c) => rotating(c));

      await value('5');
      await reason('a\u2028b');

      expect(buttonByText(fixture, 'Save').disabled, 'refused').toBe(true);
      expect(textOf(fixture), 'hint').toContain('One line of plain text');
    });

    it('when the server refuses then the message never repeats the reason, nor a toast or storage (E12)', async () => {
      await render((c) => rotating(c));

      await value('5');
      await reason('secret reason text');
      buttonByText(fixture, 'Save').click();
      await settle();
      expectRequest('PUT', `${SESSION}/items/${ITEM_A}/estimate`, 'estimate').flush(
        { code: 'PLANNING_ITEM_NOT_HELD', status: 409, title: 'Not held' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
      await fixture.whenStable();

      const alert = (fixture.nativeElement as HTMLElement).querySelector('[role=alert]');
      expect(alert?.textContent, 'message').toContain('This card is not yours in this round.');
      expect(alert?.textContent, 'no reason in the message').not.toContain('secret');
      expect(TestBed.inject(Toasts).toasts(), 'no toast').toEqual([]);
      expect(JSON.stringify({ ...localStorage }), 'nothing stored').not.toContain('secret');
    });

    it('when the caller only watches then there are no cards to estimate', async () => {
      await render((c) => ({ ...rotating(c), me: { seated: false, moderator: true } }));

      expect(textOf(fixture), 'watching').toContain('You watch this session.');
      expect(heldCards().length, 'nothing held').toBe(0);
    });
  });
});
