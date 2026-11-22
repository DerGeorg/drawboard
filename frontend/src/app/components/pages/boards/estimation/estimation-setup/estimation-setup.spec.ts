import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, EstimationSessionSummary, NewEstimationSession } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { BoardDoc } from '@apps/drawboard-engine';
import { all, buttonByText, textOf, typeInto } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../../test/http-testing';
import { SESSION_ID, aBoardWithCards, aSession, aSummary } from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { EstimationSetup, SETUP_DEFAULTS, settingsOf } from './estimation-setup';

const SESSIONS = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`;

describe('EstimationSetup', () => {
  let fixture: ComponentFixture<EstimationSetup>;
  let board: BoardDoc;
  let engine: BoardEngine;
  let ids: ReturnType<typeof aBoardWithCards>;
  let created: string[];
  let closes: number;

  async function render(
    options: { selected?: (c: typeof ids) => string[]; active?: EstimationSessionSummary[] } = {},
  ): Promise<void> {
    const fake = provideFakeAuth();
    fake.auth.signIn('alice');
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    ids = aBoardWithCards();
    board = ids.board;
    engine = new BoardEngine(document.createElement('div'), board);
    engine.selection.set(options.selected?.(ids) ?? [ids.storyId]);
    const estimation = TestBed.inject(BoardEstimation);
    estimation.open(SPRINT_BOARD_ID, BoardRole.EDITOR);
    await settle();
    expectRequest('GET', SESSIONS, 'list').flush({ items: options.active ?? [] });
    created = [];
    closes = 0;
    fixture = TestBed.createComponent(EstimationSetup, {
      bindings: [
        inputBinding('engine', () => engine),
        outputBinding<string>('created', (id) => created.push(id)),
        outputBinding('closed', () => closes++),
      ],
    });
    await fixture.whenStable();
  }

  afterEach(() => {
    engine.destroy();
    board.destroy();
  });

  function checkboxes(): HTMLInputElement[] {
    return all<HTMLInputElement>(fixture, '[data-testid=setup-items] input[type=checkbox]');
  }

  async function choose(selector: string, value: string): Promise<void> {
    const select = (fixture.nativeElement as HTMLElement).querySelector(
      selector,
    ) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new Event('input'));
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
  }

  async function submit(): Promise<NewEstimationSession> {
    buttonByText(fixture, 'Create session').click();
    await settle();
    const req = expectRequest('POST', SESSIONS, 'create');
    const body = req.request.body as NewEstimationSession;
    req.flush(aSession());
    await settle();
    return body;
  }

  describe('defaults', () => {
    it('when it opens then the selected card is picked, Magic is chosen and the session is anonymous', async () => {
      await render();

      expect(
        checkboxes().map((c) => c.checked),
        'the story from the selection',
      ).toEqual([true, false]);
      expect(textOf(fixture), 'both cards offered').toContain('Checkout');
      expect(all(fixture, '[data-testid=magic-settings]').length, 'magic settings').toBe(1);
      const anonymous = all<HTMLInputElement>(fixture, 'input[type=checkbox]').at(-1);
      expect(anonymous?.checked, 'anonymous by default (E1)').toBe(true);
    });

    it('when nothing is picked then it says so and cannot be created', async () => {
      await render({ selected: () => [] });

      expect(textOf(fixture), 'hint').toContain('Pick at least one card.');
      expect(buttonByText(fixture, 'Create session').disabled, 'disabled').toBe(true);
    });

    it('when a card is in another active session then it carries a hint', async () => {
      await render({ active: [aSummary()] });
      await settle();
      expectRequest('GET', `${SESSIONS}/${SESSION_ID}`, 'read the active session').flush(
        aSession({
          items: [
            {
              id: 'i',
              ref: { kind: 'STORY', blockId: ids.storyId },
              title: 'Login',
              position: 0,
              mine: false,
            },
          ],
        }),
      );
      await settle();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=setup-items] .badge').length, 'one hint').toBe(1);
    });
  });

  describe('create', () => {
    it('when a Magic session is created then refs, copied titles and only Magic settings go out', async () => {
      await render();
      typeInto(fixture, 'input[type=text]', 'Sprint 42');
      buttonByText(fixture, 'All').click();
      await fixture.whenStable();

      const body = await submit();

      expect(body, 'body').toEqual({
        mode: 'MAGIC',
        title: 'Sprint 42',
        deck: { kind: 'FIBONACCI' },
        items: [
          { ref: ids.storyRef, title: 'Login' },
          { ref: ids.cardRef, title: 'Checkout' },
        ],
        anonymous: true,
        settings: { placingSeconds: 180, movingSeconds: 300, markThreshold: 3 },
      });
      expect(created, 'opens the lobby').toEqual([SESSION_ID]);
    });

    it('when Rotation is chosen then "each sees N cards" sets the rounds and only Rotation settings go out', async () => {
      await render();
      typeInto(fixture, 'input[type=text]', 'Sprint 42');
      buttonByText(fixture, 'All').click();
      await choose('select', 'ROTATION');
      expect(all(fixture, '[data-testid=rotation-settings]').length, 'rotation').toBe(1);
      const expected = (fixture.nativeElement as HTMLElement).querySelector(
        '[id$=-expected]',
      ) as HTMLInputElement;
      expected.value = '2';
      expected.dispatchEvent(new Event('change'));
      const wanted = (fixture.nativeElement as HTMLElement).querySelector(
        '[id$=-wanted]',
      ) as HTMLInputElement;
      wanted.value = '2';
      wanted.dispatchEvent(new Event('change'));
      buttonByText(fixture, 'Set rounds').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'helper').toContain('each sees about 2 cards');

      const body = await submit();

      expect(body.settings, 'rotation settings only').toEqual({
        rounds: 2,
        roundSeconds: 120,
        advanceWhenDone: true,
      });
      expect(body.mode, 'mode').toBe('ROTATION');
    });

    it('when the name has a line separator then nothing is sent', async () => {
      await render();
      typeInto(fixture, 'input[type=text]', 'Sprint\u202842');
      buttonByText(fixture, 'Create session').click();
      await settle();

      TestBed.inject(HttpTestingController).expectNone(SESSIONS, 'refused in the browser');
      expect(textOf(fixture), 'message').toContain('One line of plain text');
    });

    it('when the server refuses then the message shows and the dialog stays', async () => {
      await render();
      typeInto(fixture, 'input[type=text]', 'Sprint 42');
      buttonByText(fixture, 'Create session').click();
      await settle();
      expectRequest('POST', SESSIONS, 'create').flush(
        { code: 'PLANNING_SESSION_LIMIT_REACHED', status: 409, title: 'Conflict' },
        problemResponse(409, 'Conflict'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'message').toContain('as many active estimation sessions');
      expect(created, 'not created').toEqual([]);
    });

    it('when cards are picked by hand, cleared and taken from the selection then the checklist follows', async () => {
      await render({ selected: (c) => [c.kanbanId] });
      expect(
        checkboxes().map((c) => c.checked),
        'the kanban card from the selection',
      ).toEqual([false, true]);

      buttonByText(fixture, 'None').click();
      await fixture.whenStable();
      checkboxes()[0]?.dispatchEvent(new Event('change'));
      await fixture.whenStable();
      expect(
        checkboxes().map((c) => c.checked),
        'by hand',
      ).toEqual([true, false]);
      checkboxes()[0]?.dispatchEvent(new Event('change'));
      buttonByText(fixture, 'Take from selection').click();
      await fixture.whenStable();
      expect(
        checkboxes().map((c) => c.checked),
        'from selection',
      ).toEqual([false, true]);

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      expect(closes, 'Escape closes').toBe(1);
    });
  });

  describe('settingsOf', () => {
    it('when the mode is Magic or Rotation then only its fields are set', () => {
      expect(Object.keys(settingsOf(SETUP_DEFAULTS)), 'magic').toEqual([
        'placingSeconds',
        'movingSeconds',
        'markThreshold',
      ]);
      expect(Object.keys(settingsOf({ ...SETUP_DEFAULTS, mode: 'ROTATION' })), 'rotation').toEqual([
        'rounds',
        'roundSeconds',
        'advanceWhenDone',
      ]);
    });
  });
});
