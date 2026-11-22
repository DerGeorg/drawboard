import { HttpTestingController } from '@angular/common/http/testing';
import { WritableSignal, inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, EstimationSession } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { all, textOf } from '../../../../../test/dom';
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
  SESSION_ID,
  aBoardWithCards,
  aMagicSession,
  anItem,
} from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { MagicOverlay } from './magic-overlay';

const SESSION = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions/${SESSION_ID}`;

describe('MagicOverlay', () => {
  let fixture: ComponentFixture<MagicOverlay>;
  let engine: BoardEngine;
  let ids: ReturnType<typeof aBoardWithCards>;
  let session: WritableSignal<EstimationSession>;
  let presence: number;

  async function render(value: (c: typeof ids) => EstimationSession, remaining = 30_000) {
    const fake = provideFakeAuth();
    fake.auth.signIn('alice');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    ids = aBoardWithCards();
    engine = new BoardEngine(document.createElement('div'), ids.board);
    presence = 0;
    engine.localPresence.on(() => presence++);
    const estimation = TestBed.inject(BoardEstimation);
    estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
    await settle();
    expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`, 'list').flush({
      items: [],
    });
    session = signal(value(ids));
    fixture = TestBed.createComponent(MagicOverlay, {
      bindings: [
        inputBinding('session', session),
        inputBinding('engine', () => engine),
        inputBinding('remainingMs', () => remaining),
      ],
    });
    await fixture.whenStable();
  }

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    engine.destroy();
    ids.board.destroy();
  });

  function cards(): HTMLElement[] {
    return all(fixture, '[data-testid=magic-card]');
  }

  function zone(value: string): HTMLElement {
    return (fixture.nativeElement as HTMLElement).querySelector(
      `[data-drop="${value}"]`,
    ) as HTMLElement;
  }

  /** Gives a drop zone a box on screen (jsdom has no layout). */
  function place(element: HTMLElement, left: number, top: number): void {
    element.getBoundingClientRect = () =>
      ({ left, top, right: left + 100, bottom: top + 300, width: 100, height: 300 }) as DOMRect;
  }

  function pointer(target: EventTarget, type: string, x: number, y: number): void {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }),
    );
  }

  /** Two cards with live refs: ITEM_A on the story, ITEM_B on the kanban card. */
  function items(c: typeof ids, a = {}, b = {}) {
    return [
      anItem({ ref: c.storyRef, ...a }),
      anItem({ id: ITEM_B, ref: c.cardRef, title: 'Old title', position: 1, ...b }),
    ];
  }

  describe('placing (E3, E4)', () => {
    it('when the phase is PLACING then only the own cards show, the others are only counted', async () => {
      await render((c) => aMagicSession({ items: items(c, { mine: true, column: '5' }) }));

      expect(cards().length, 'own card only').toBe(1);
      expect(zone('5').textContent, 'in its column').toContain('Login');
      expect(textOf(fixture), 'others hidden').toContain(
        '1 card of others is hidden until moving.',
      );
      expect(all(fixture, '[data-testid=move-count]').length, 'no move counts').toBe(0);
      expect(
        all<HTMLElement>(fixture, '[data-drop]').map((z) => z.dataset['drop']),
        'columns without coffee, ? parks, tray last',
      ).toEqual(['0', '1', '2', '3', '5', '8', '13', '21', '?', '']);
      const bar = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid=magic-timer] > div',
      ) as HTMLElement;
      expect(bar.style.width, 'half of 60 s left').toBe('50%');
    });

    it('when an own card is dragged onto a column then it is placed there with the phase we see, and no awareness is sent', async () => {
      await render((c) => aMagicSession({ items: items(c, { mine: true }) }));
      place(zone('8'), 500, 100);
      const card = cards()[0] as HTMLElement;

      pointer(card, 'pointerdown', 10, 10);
      pointer(card, 'pointermove', 520, 150);
      await fixture.whenStable();
      expect(zone('8').className, 'drop zone lit').toContain('border-(--color-st-yellow)');
      expect(card.style.transform, 'follows the pointer').toBe('translate(510px, 140px)');
      pointer(card, 'pointerup', 520, 150);
      await fixture.whenStable();
      expect(zone('8').textContent, 'shown at once').toContain('Login');

      await settle();
      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'placement');
      expect(req.request.body, 'value and expected state (E14)').toEqual({
        value: '8',
        state: 'PLACING',
      });
      req.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      expect(presence, 'no cursor, no drag in awareness (E19)').toBe(0);
    });

    it('when the phase changes during a drag then the placement names the old phase, and a rendered new phase ends the drag (S1)', async () => {
      await render((c) => aMagicSession({ items: items(c, { mine: true }) }));
      place(zone('8'), 500, 100);
      let card = cards()[0] as HTMLElement;

      // MOVING arrives while the card is in the air: the drop still names PLACING (409 then)
      pointer(card, 'pointerdown', 10, 10);
      pointer(card, 'pointermove', 520, 150);
      session.set(aMagicSession({ state: 'MOVING', items: items(ids, { column: '1' }) }));
      pointer(card, 'pointerup', 520, 150);
      await settle();
      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'placement');
      expect(req.request.body, 'the phase of the pointerdown').toEqual({
        value: '8',
        state: 'PLACING',
      });
      req.flush(
        { code: 'PLANNING_SESSION_WRONG_STATE', status: 409, title: 'Conflict' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
      await fixture.whenStable();

      // once the new phase is on screen, a drag that began before it simply ends
      card = cards()[0] as HTMLElement;
      place(zone('8'), 500, 100);
      pointer(card, 'pointerdown', 10, 10);
      pointer(card, 'pointermove', 520, 150);
      session.set(aMagicSession({ state: 'PLACING', items: items(ids, { mine: true }) }));
      await fixture.whenStable();
      expect(card.style.transform, 'the drag ended').toBe('');
      pointer(card, 'pointerup', 520, 150);
      await settle();
      expect(engine.selection.list(), 'no selection (Fable F1)').toEqual([]);
    });

    it('when a card is only clicked or dropped outside then nothing is sent', async () => {
      await render((c) => aMagicSession({ items: items(c, { mine: true, column: '3' }) }));
      const card = cards()[0] as HTMLElement;

      pointer(card, 'pointerdown', 10, 10);
      pointer(card, 'pointerup', 11, 11);
      pointer(card, 'pointerdown', 10, 10);
      pointer(card, 'pointermove', 900, 900);
      pointer(card, 'pointerup', 900, 900);
      pointer(card, 'pointerdown', 10, 10);
      card.dispatchEvent(new Event('pointercancel', { bubbles: true }));
      await settle();

      expect(zone('3').textContent, 'stays').toContain('Login');
    });

    it('when the keyboard moves a card then arrows go to the next column and Delete takes it out', async () => {
      await render((c) => aMagicSession({ items: items(c, { mine: true, column: '3' }) }));
      const card = cards()[0] as HTMLElement;

      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await settle();
      const right = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'right');
      expect(right.request.body.value, 'next column').toBe('5');
      right.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      // the server's answer: the card sits in 5 now (the element is a new one there)
      session.set(aMagicSession({ items: items(ids, { mine: true, column: '5' }) }));
      await fixture.whenStable();
      const moved = zone('5').querySelector('[data-testid=magic-card]') as HTMLElement;

      moved.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await settle();
      const out = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/placement`, 'out');
      expect(out.request.body.value, 'out of its column').toBeNull();
      out.flush(null, { status: 204, statusText: 'No Content' });
      await settle();

      moved.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      await settle();
    });
  });

  describe('moving (E4)', () => {
    it('when the phase is MOVING then every card shows with moves and mark, and anyone seated moves any card', async () => {
      await render((c) =>
        aMagicSession({
          state: 'MOVING',
          items: items(
            c,
            { column: '5', moveCount: 4, marked: true },
            { column: '?', moveCount: 0, marked: true },
          ),
        }),
      );

      expect(cards().length, 'all cards').toBe(2);
      expect(zone('5').textContent, 'moves').toContain('moved 4×');
      expect(all(fixture, '[data-testid=marked]').length, 'both marked').toBe(2);
      expect(zone('?').textContent, 'live title from the document (E20)').toContain('Checkout');
      expect(textOf(fixture), 'never who moved').not.toMatch(/Alice|Bob|Gina/);

      const card = zone('?').querySelector('[data-testid=magic-card]') as HTMLElement;
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await settle();
      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_B}/placement`, 'move');
      expect(req.request.body, 'moving').toEqual({ value: '21', state: 'MOVING' });
      req.flush(
        { code: 'PLANNING_MOVE_LIMIT_REACHED', status: 409, title: 'Limit' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'limit').toContain('as often as allowed');
      expect(zone('?').textContent, 'back where it was').toContain('Checkout');
    });

    it('when the caller only watches then no card can be moved', async () => {
      await render((c) =>
        aMagicSession({
          state: 'MOVING',
          me: { seated: false, moderator: true },
          items: items(c, { column: '5' }, { column: '8' }),
        }),
      );

      expect(textOf(fixture), 'watching').toContain('You watch this session.');
      expect(
        cards().map((c) => c.getAttribute('tabindex')),
        'not focusable',
      ).toEqual([null, null]);
      const card = cards()[0] as HTMLElement;
      pointer(card, 'pointerdown', 10, 10);
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await settle();
    });

    it('when a card was left without a column then it waits in "Not placed"', async () => {
      await render((c) => aMagicSession({ state: 'MOVING', items: items(c, { column: '1' }) }));

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid=magic-tray]')
          ?.textContent,
        'tray',
      ).toContain('Checkout');
    });
  });
});
