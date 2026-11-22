import { HttpTestingController } from '@angular/common/http/testing';
import { WritableSignal, inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, EstimationItemResult, EstimationSession } from '@apps/drawboard-api';

import { KanbanModel, StoryModel } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../../board-engine/engine';
import { all, buttonByLabel, buttonByText, buttonTexts, textOf } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../../test/http-testing';
import {
  ITEM_A,
  ITEM_B,
  SESSION_ID,
  aBoardWithCards,
  aMagicSession,
  aSession,
  anItem,
} from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { EstimationReview } from './estimation-review';

const SESSION = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions/${SESSION_ID}`;

function aResult(overrides: Partial<EstimationItemResult> = {}): EstimationItemResult {
  return {
    entries: [
      { value: '3', kept: false },
      { value: '5', kept: false, reason: '<a href="https://evil.example">click</a>' },
      { value: '5', kept: true },
    ],
    average: 4.33,
    median: 5,
    distribution: [
      { value: '3', count: 1 },
      { value: '5', count: 2 },
    ],
    candidates: ['3', '5'],
    moveTrail: [],
    ...overrides,
  };
}

describe('EstimationReview', () => {
  let fixture: ComponentFixture<EstimationReview>;
  let engine: BoardEngine;
  let ids: ReturnType<typeof aBoardWithCards>;
  let session: WritableSignal<EstimationSession>;

  async function render(
    value: (c: typeof ids) => EstimationSession,
    readOnly = false,
  ): Promise<void> {
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
    session = signal(value(ids));
    fixture = TestBed.createComponent(EstimationReview, {
      bindings: [
        inputBinding('session', session),
        inputBinding('engine', () => engine),
        inputBinding('readOnly', () => readOnly),
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
    return all(fixture, '[data-testid=review-card]');
  }

  /** Rotation in REVIEW: the story card has three entries, the kanban card none. */
  function review(c: typeof ids, overrides: Partial<EstimationSession> = {}): EstimationSession {
    return aSession({
      state: 'REVIEW',
      round: 1,
      items: [
        anItem({ ref: c.storyRef, result: aResult() }),
        anItem({
          id: ITEM_B,
          ref: c.cardRef,
          title: 'Checkout',
          position: 1,
          result: aResult({
            entries: [],
            average: undefined,
            median: undefined,
            distribution: [],
            candidates: [],
          }),
        }),
      ],
      ...overrides,
    });
  }

  describe('results (E5, E12)', () => {
    it('when an anonymous Rotation is reviewed then stats, values and reasons show as text without names', async () => {
      await render((c) => review(c));

      const first = cards()[0] as HTMLElement;
      expect(first.textContent?.replace(/\s+/g, ' '), 'stats').toContain('Average 4.33 · median 5');
      expect(first.querySelectorAll('[data-testid=entries] li').length, 'entries').toBe(3);
      const reason = first.querySelector('[data-testid=reason]') as HTMLElement;
      expect(reason.textContent, 'reason as plain text').toContain('<a href=');
      expect(first.querySelectorAll('a').length, 'never a link').toBe(0);
      expect(textOf(fixture), 'no names').not.toMatch(/Alice|Bob|Gina/);
    });

    it('when the session is not anonymous then each value carries its name', async () => {
      await render((c) =>
        review(c, {
          anonymous: false,
          items: [
            anItem({
              ref: c.storyRef,
              result: aResult({
                entries: [
                  { value: '3', kept: false, displayName: 'Bob Builder', guest: false },
                  { value: '5', kept: false, displayName: 'Gina', guest: true, reason: 'Big' },
                ],
              }),
            }),
          ],
        }),
      );

      expect(textOf(fixture), 'names').toContain('Bob Builder');
      expect(textOf(fixture), 'guest').toContain('Gina (guest)');
    });

    it('when the live title differs from the stored copy then both show', async () => {
      await render((c) => review(c));
      new StoryModel(ids.board, ids.storyId).setTitle('Sign in');
      await fixture.whenStable();

      expect(textOf(fixture), 'live').toContain('Sign in');
      expect(textOf(fixture), 'stored').toContain('Was: Login');
      buttonByLabel(fixture, 'Show Sign in on the board').click();
      expect(engine.selection.list(), 'jumps to the card').toEqual([ids.storyId]);
    });

    it('when Magic is reviewed then column, moves and the trail show', async () => {
      await render((c) =>
        aMagicSession({
          state: 'REVIEW',
          items: [
            anItem({
              ref: c.storyRef,
              column: '5',
              moveCount: 2,
              marked: true,
              result: aResult({
                entries: [],
                distribution: [],
                candidates: ['0', '1', '2', '3', '5', '8', '13', '21', '?'],
                moveTrail: ['3', '8', '5'],
              }),
            }),
          ],
        }),
      );

      expect(textOf(fixture), 'column').toContain('Column: 5 · moved 2×');
      expect(textOf(fixture), 'trail').toContain('Went through: 3 → 8 → 5');
      expect(textOf(fixture), 'marked').toContain('marked');
    });
  });

  describe('decide and finish (E13)', () => {
    it('when the moderator decides then only entered values are offered, or every deck value for a card without entries', async () => {
      await render((c) => review(c));

      const [first, second] = cards() as [HTMLElement, HTMLElement];
      expect(
        Array.from(first.querySelectorAll('[role=group] button')).map((b) => b.textContent?.trim()),
        'candidates',
      ).toEqual(['3', '5']);
      expect(
        second.querySelectorAll('[role=group] button').length,
        'no entry: the whole deck (overridden)',
      ).toBe(10);

      (first.querySelectorAll('[role=group] button')[1] as HTMLButtonElement).click();
      await settle();
      const req = expectRequest('PUT', `${SESSION}/items/${ITEM_A}/decision`, 'decide');
      expect(req.request.body, 'value').toEqual({ value: '5' });
      req.flush(null, { status: 204, statusText: 'No Content' });
      await settle();

      buttonByText(fixture, 'Finish session').click();
      await settle();
      expectRequest('POST', `${SESSION}/finish`, 'finish').flush(
        review(ids, { state: 'DONE', version: 9 }),
      );
      await settle();
    });

    it('when a decision was overridden then it says so; others cannot decide', async () => {
      await render((c) =>
        review(c, {
          me: { seated: true, moderator: false },
          items: [anItem({ ref: c.storyRef, result: aResult(), decision: '8', overridden: true })],
        }),
      );

      expect(textOf(fixture), 'decision').toContain('8');
      expect(all(fixture, '[data-testid=overridden]').length, 'overridden').toBe(1);
      expect(all(fixture, '[role=group]').length, 'no decide buttons').toBe(0);
      expect(buttonTexts(fixture), 'no finish').not.toContain('Finish session');
    });

    it('when the moderator decides a Magic card then deck columns are offered', async () => {
      await render((c) =>
        aMagicSession({
          state: 'REVIEW',
          items: [
            anItem({
              ref: c.storyRef,
              column: '5',
              marked: false,
              result: aResult({ candidates: ['5'] }),
            }),
          ],
        }),
      );

      expect(
        all(fixture, '[role=group] button').map((b) => b.textContent?.trim()),
        'columns without coffee',
      ).toEqual(['0', '1', '2', '3', '5', '8', '13', '21', '?']);
    });
  });

  describe('writing results (E21)', () => {
    /** DONE: the story decided 5, the kanban card decided 8. */
    function done(c: typeof ids, kanbanDecision = '8'): EstimationSession {
      return aSession({
        state: 'DONE',
        items: [
          anItem({ ref: c.storyRef, result: aResult(), decision: '5' }),
          anItem({
            id: ITEM_B,
            ref: c.cardRef,
            title: 'Checkout',
            position: 1,
            result: aResult(),
            decision: kanbanDecision,
          }),
        ],
      });
    }

    it('when a matching card is written then the current value shows first and the decision goes in', async () => {
      await render((c) => done(c));

      expect(textOf(fixture), 'current value first').toContain('On the card now: no estimate');
      buttonByText(fixture, 'Write 5').click();
      await fixture.whenStable();

      expect(new StoryModel(ids.board, ids.storyId).read().estimate, 'story estimate').toBe('5');
      expect(textOf(fixture), 'written').toContain('On the card now: 5 · written');
      buttonByText(fixture, 'Write 1 decision to the cards').click();
      await fixture.whenStable();
      const card = new KanbanModel(ids.board, ids.kanbanId).card(ids.cardId);
      expect([card?.estimate, card?.points], 'kanban estimate and points').toEqual(['8', 8]);
      expect(all(fixture, '[data-testid=write-all]').length, 'nothing left').toBe(0);
    });

    it('when a card does not match or a kanban value is no whole number then nothing is written', async () => {
      await render((c) => done(c, 'XL'));
      ids.board.deleteItems([ids.storyId]);
      await fixture.whenStable();

      expect(textOf(fixture), 'gone').toContain('This card is gone or changed');
      expect(textOf(fixture), 'kanban value').toContain('whole numbers from 0 to 999 only');
      expect(all(fixture, '[data-testid=write-all]').length, 'nothing to write').toBe(0);
      expect(
        new KanbanModel(ids.board, ids.kanbanId).card(ids.cardId)?.estimate,
        'untouched',
      ).toBeNull();
    });

    it('when the board is read-only then the decisions are shown but not written', async () => {
      await render((c) => done(c), true);

      expect(textOf(fixture), 'shown').toContain('On the card now: no estimate');
      expect(buttonTexts(fixture), 'no write').not.toContain('Write 5');
      expect(all(fixture, '[data-testid=write-all]').length, 'no write all').toBe(0);
    });

    it('when the session is only in REVIEW then nothing can be written yet', async () => {
      await render((c) =>
        review(c, { items: [anItem({ ref: c.storyRef, result: aResult(), decision: '5' })] }),
      );

      expect(all(fixture, '[data-testid=write-state]').length, 'not before DONE').toBe(0);
    });
  });
});
