import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, GrantRole, PokerRound, PokerRoundState } from '@apps/drawboard-api';

import { STORY_TYPE, StoryModel, newStoryProps, BoardDoc } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../../board-engine/engine';
import { all, buttonByLabel, buttonByText, textOf } from '../../../../../test/dom';
import { FakeAuth, provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../../test/http-testing';
import { ROUND_ID, aPokerRound } from '../../testing/poker';
import { BoardPoker } from '../board-poker';
import { parseCustomDeck } from '../../../../shared/deck-picker/deck-picker';
import { BoardPokerDialog, POKER_CANDIDATE_DEBOUNCE_MS } from './board-poker-dialog';

const ROUNDS = `/api/boards/${SPRINT_BOARD_ID}/poker-rounds`;
const ROUND = `${ROUNDS}/${ROUND_ID}`;
const OTHER_ROUND_ID = '0192aaaa-0000-7000-8000-0000000000ff';
const OTHER_CARD = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
/** The debounce window of the candidate round in these tests (production: 1 s). */
const WINDOW = 120;

describe('BoardPokerDialog', () => {
  let fixture: ComponentFixture<BoardPokerDialog>;
  let board: BoardDoc;
  let engine: BoardEngine;
  let story: StoryModel;
  let id: string;
  let poker: BoardPoker;
  let auth: FakeAuth;
  let closed: number;
  let rendered = false;

  interface Setup {
    role?: BoardRole;
    guest?: GrantRole;
    readOnly?: boolean;
    /** The open rounds the server lists, given the story card's id. */
    open?: (storyId: string) => PokerRound[];
    pokerRoundId?: string;
    /** Quick mode: no card bound; `roundId` the quick round to show (absent: start one). */
    quick?: { roundId?: string };
    /** Card mode without a block id (a caller bug): the dialog must not turn into a quick one. */
    withoutBlockId?: boolean;
  }

  async function render(setup: Setup = {}): Promise<void> {
    const fake = provideFakeAuth();
    auth = fake.auth;
    if (setup.guest) {
      auth.signInAsGuest({ name: 'Gina', role: setup.guest, kind: 'BOARD', id: SPRINT_BOARD_ID });
    } else {
      auth.signIn('alice', 'Alice Admin');
    }
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpTesting(),
        fake.providers,
        BoardPoker,
        { provide: POKER_CANDIDATE_DEBOUNCE_MS, useValue: WINDOW },
      ],
    });
    board = new BoardDoc();
    engine = new BoardEngine(document.createElement('div'), board, {
      readOnly: setup.readOnly ?? false,
    });
    id = board.addBlock({
      type: STORY_TYPE,
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      props: newStoryProps(),
      text: 'Login',
    });
    story = new StoryModel(board, id);
    if (setup.pokerRoundId) {
      story.setPokerRound(setup.pokerRoundId);
    }
    poker = TestBed.inject(BoardPoker);
    poker.open(SPRINT_BOARD_ID, setup.role ?? BoardRole.EDITOR);
    await settle();
    if (!setup.guest || setup.guest !== GrantRole.VIEWER) {
      expectRequest('GET', ROUNDS, 'list').flush({ items: setup.open?.(id) ?? [] });
    }
    closed = 0;
    rendered = true;
    const quick = setup.quick;
    fixture = TestBed.createComponent(BoardPokerDialog, {
      bindings: quick
        ? [
            inputBinding('engine', () => engine),
            inputBinding('mode', () => 'quick'),
            inputBinding('roundId', () => quick.roundId),
            outputBinding('closed', () => closed++),
          ]
        : [
            inputBinding('engine', () => engine),
            inputBinding('mode', () => 'card'),
            inputBinding('blockId', () => (setup.withoutBlockId ? undefined : id)),
            outputBinding('closed', () => closed++),
          ],
    });
    await settle();
  }

  /** The open round of this card (its storyBlockId is the card's id). */
  const round = (overrides: Partial<PokerRound> = {}): PokerRound =>
    aPokerRound({ storyBlockId: id, ...overrides });
  /** Answers the pending poll of the round. */
  async function poll(answer: PokerRound): Promise<void> {
    expectRequest('GET', ROUND, 'poll').flush(answer, {
      headers: { ETag: `W/"${answer.version}"` },
    });
    await settle();
  }
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  function set(selector: string, value: string): void {
    const input = el().querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  }
  async function submit(): Promise<void> {
    el()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  }
  function problem(code: string, status: number, params?: Record<string, string>) {
    return [
      { code, status, title: code, params },
      { status, statusText: code },
    ] as const;
  }

  afterEach(() => {
    if (!rendered) {
      return;
    }
    rendered = false;
    fixture.destroy();
    engine.destroy();
    board.destroy();
    TestBed.inject(HttpTestingController)
      .match(() => true)
      .forEach((r) => r.flush(null));
    TestBed.resetTestingModule();
  });

  describe('starting a round', () => {
    it('when an editor starts a round then it is created and the card announces its id only', async () => {
      await render();

      expect(all(fixture, '[data-testid=poker-start]').length, 'start form').toBe(1);
      set('select', 'TSHIRT');
      await submit();
      const create = expectRequest('POST', ROUNDS, 'create');
      expect(create.request.body, 'body').toEqual({
        storyBlockId: id,
        title: 'Login',
        deck: { kind: 'TSHIRT' },
      });
      create.flush(round(), { status: 201, statusText: 'Created' });
      await settle();

      expect(story.read().pokerRoundId, 'announced').toBe(ROUND_ID);
      expect(JSON.stringify(board.blocksMap.toJSON()), 'no deck, no vote in the doc').not.toContain(
        'XL',
      );
      await poll(round());
      expect(all(fixture, '[data-testid=poker-open]').length, 'round shown').toBe(1);
    });

    it('when a custom deck is typed then it is checked and sent', async () => {
      await render();

      set('select', 'CUSTOM');
      await fixture.whenStable();
      set('input[placeholder="1, 2, 4, 8, 16, ?"]', '1, 1');
      await submit();
      expect(textOf(fixture), 'message').toContain('Each value only once.');

      set('input[placeholder="1, 2, 4, 8, 16, ?"]', '1, 2, 4, ?');
      await submit();
      expect(expectRequest('POST', ROUNDS, 'create').request.body.deck, 'deck').toEqual({
        kind: 'CUSTOM',
        values: ['1', '2', '4', '?'],
      });
    });

    it('when the card already has an open round then the dialog binds to it', async () => {
      await render();

      await submit();
      expectRequest('POST', ROUNDS, 'create').flush(
        ...problem('PLANNING_ROUND_ALREADY_OPEN', 409, { storyBlockId: id, roundId: ROUND_ID }),
      );
      await settle();

      expect(textOf(fixture), 'message').toContain('already open on this story card');
      expect(story.read().pokerRoundId, 'bound').toBe(ROUND_ID);
      await poll(round());
      expect(all(fixture, '[data-testid=poker-open]').length, 'shown').toBe(1);
    });

    it('when the board has too many open rounds or the user too many starts then the dialog says so', async () => {
      await render();

      await submit();
      expectRequest('POST', ROUNDS, 'create').flush(
        ...problem('PLANNING_ROUND_LIMIT_REACHED', 409, { limit: '10' }),
      );
      await settle();
      expect(textOf(fixture), 'limit').toContain('already has 10 open estimation rounds');

      await submit();
      expectRequest('POST', ROUNDS, 'create').flush(...problem('TOO_MANY_REQUESTS', 429));
      await settle();
      expect(textOf(fixture), '429').toContain('Too many requests');
    });

    it('when a commenter opens a card without a round then nothing can be started', async () => {
      await render({ role: BoardRole.COMMENTER });

      expect(all(fixture, '[data-testid=poker-start]').length, 'no form').toBe(0);
      expect(textOf(fixture), 'idle').toContain('No estimation is running');
    });
  });

  describe('binding rule', () => {
    it('when the card points to a round of another card then the round is ignored', async () => {
      await render({ pokerRoundId: ROUND_ID });

      await poll(aPokerRound({ storyBlockId: OTHER_CARD }));

      expect(all(fixture, '[data-testid=poker-open]').length, 'not shown').toBe(0);
      expect(all(fixture, '[data-testid=poker-start]').length, 'start instead').toBe(1);
      expect(poker.pollerCount, 'lease released').toBe(0);
      TestBed.inject(HttpTestingController).expectNone(ROUND, 'no further polling');
    });

    it('when the card points to the round of another card then its own paired round still shows', async () => {
      await render({
        pokerRoundId: OTHER_ROUND_ID,
        open: (storyId) => [aPokerRound({ storyBlockId: storyId })],
      });

      await poll(round());

      expect(story.read().pokerRoundId, 'the hint is the forged one').toBe(OTHER_ROUND_ID);
      expect(all(fixture, '[data-testid=poker-open]').length, 'own round shown').toBe(1);
      TestBed.inject(HttpTestingController).expectNone(
        `${ROUNDS}/${OTHER_ROUND_ID}`,
        'the forged round is never fetched',
      );
    });

    it('when the hint flips quickly then at most one round is fetched per window', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round());
      const http = TestBed.inject(HttpTestingController);

      for (const next of [OTHER_ROUND_ID, ROUND_ID, OTHER_ROUND_ID, ROUND_ID, OTHER_ROUND_ID]) {
        story.setPokerRound(next);
        await settle();
      }
      http.expectNone(`${ROUNDS}/${OTHER_ROUND_ID}`, 'nothing during the window');
      await new Promise((resolve) => setTimeout(resolve, WINDOW + 60));
      await settle();

      const fetched = http.match((r) => r.url === `${ROUNDS}/${OTHER_ROUND_ID}`);
      expect(fetched.length, 'one fetch for the final value').toBe(1);
      fetched.forEach((r) => r.flush(null));
      expect(
        http.match((r) => r.url === ROUND).length,
        'the first round is not fetched again',
      ).toBe(0);
    });

    it('when the dialog is released after a mismatch then a poller shared with another holder keeps running', async () => {
      await render({ pokerRoundId: ROUND_ID });
      const other = poker.acquire(ROUND_ID);
      const stop = vi.spyOn(other, 'stop');

      await poll(aPokerRound({ storyBlockId: OTHER_CARD }));

      expect(stop, 'not stopped').not.toHaveBeenCalled();
      expect(poker.pollerCount, 'still leased by the other holder').toBe(1);
      poker.release(ROUND_ID);
      expect(poker.pollerCount, 'gone with the last holder').toBe(0);
    });

    it('when the server lists an open round for this card then it shows even without the card id', async () => {
      await render({ open: (storyId) => [aPokerRound({ storyBlockId: storyId })] });

      await poll(round());

      expect(story.read().pokerRoundId, 'the card itself says nothing').toBeNull();
      expect(all(fixture, '[data-testid=poker-open]').length, 'shown').toBe(1);
    });
  });

  describe('voting', () => {
    it('when a participant votes then the vote is kept and nobody sees values, only who voted', async () => {
      await render({ role: BoardRole.COMMENTER, pokerRoundId: ROUND_ID });
      await poll(
        round({
          participants: [
            { displayName: 'Deleted user', guest: false, voted: true },
            { displayName: 'Gina', guest: true, voted: false },
          ],
        }),
      );

      buttonByLabel(fixture, '5').click();
      await settle();
      expectRequest('PUT', `${ROUND}/vote`, 'vote').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expect(textOf(fixture), 'own vote').toContain('You voted 5');
      expect(buttonByLabel(fixture, '5').getAttribute('aria-pressed'), 'pressed').toBe('true');
      const people = el().querySelector('[data-testid=participants]')?.textContent ?? '';
      expect(people, 'names as text').toContain('Deleted user');
      expect(people, 'guest badge').toContain('guest');
      expect(textOf(fixture), 'count').toContain('1 of 2 voted');
      expect(buttonByLabel(fixture, 'coffee (need a break)').textContent?.trim(), 'cup').toBe('☕');
    });

    it('when a vote is refused then the reason is shown', async () => {
      await render({ role: BoardRole.COMMENTER, pokerRoundId: ROUND_ID });
      await poll(round());
      const cases: [string, number, Record<string, string> | undefined, string][] = [
        ['PLANNING_ROUND_FULL', 409, { limit: '200' }, 'full (200 participants)'],
        ['PLANNING_VALUE_INVALID', 400, undefined, 'not a card of the round'],
        ['TOO_MANY_REQUESTS', 429, undefined, 'Too many requests'],
        ['PLANNING_ROUND_CLOSED', 409, undefined, 'has ended'],
      ];
      for (const [code, status, params, text] of cases) {
        buttonByLabel(fixture, '3').click();
        await settle();
        expectRequest('PUT', `${ROUND}/vote`, code).flush(...problem(code, status, params));
        await settle();
        expect(el().querySelector('[data-testid=poker-message]')?.textContent, code).toContain(
          text,
        );
      }
      // CLOSED polls at once
      await poll(
        round({
          state: PokerRoundState.REVEALED,
          version: 2,
          result: { votes: [], distribution: [] },
        }),
      );
      expect(all(fixture, '[data-testid=poker-result]').length, 'result').toBe(1);
    });

    it('when a viewer looks at a round then they cannot vote', async () => {
      await render({ role: BoardRole.VIEWER, pokerRoundId: ROUND_ID });
      await poll(round());

      expect(textOf(fixture), 'watch only').toContain('can watch this round but not vote');
      expect(all(fixture, '[aria-label="Your vote"]').length, 'no cards').toBe(0);
    });

    it('when a guest on a comment link opens a round then they vote but never close it', async () => {
      await render({ guest: GrantRole.COMMENTER, pokerRoundId: ROUND_ID });
      await poll(round({ facilitatorId: undefined }));

      expect(all(fixture, '[aria-label="Your vote"]').length, 'cards').toBe(1);
      expect(buttonTexts(), 'no reveal').not.toContain('Reveal votes');
    });
  });

  describe('facilitating', () => {
    it('when the facilitator reveals then the result shows and the chosen estimate goes to the card', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round());

      buttonByText(fixture, 'Reveal votes').click();
      await settle();
      expectRequest('POST', `${ROUND}/reveal`, 'reveal').flush(
        round({
          state: PokerRoundState.REVEALED,
          version: 2,
          result: {
            votes: [
              { displayName: 'Alice Admin', guest: false, value: '5' },
              { displayName: 'Gina', guest: true, value: '8' },
            ],
            average: 6.5,
            median: 6.5,
            distribution: [
              { value: '5', count: 1 },
              { value: '8', count: 1 },
            ],
            suggestion: '8',
          },
        }),
      );
      await settle();

      expect(textOf(fixture), 'average').toContain('6.5');
      expect(buttonByText(fixture, '8').getAttribute('aria-pressed'), 'suggestion picked').toBe(
        'true',
      );
      buttonByText(fixture, '5').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Use 5 as the estimate').click();

      expect(story.read(), 'written').toMatchObject({ estimate: '5', pokerRoundId: null });
      expect(poker.isOpen(id), 'not open').toBe(false);
    });

    it('when the facilitator cancels then the card is released', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round());

      buttonByText(fixture, 'Cancel round').click();
      await settle();
      expectRequest('POST', `${ROUND}/cancel`, 'cancel').flush(
        round({ state: PokerRoundState.CANCELLED, version: 2 }),
      );
      await settle();

      expect(story.read().pokerRoundId, 'cleared').toBeNull();
      expect(poker.pollerCount, 'nothing to poll').toBe(0);
      expect(all(fixture, '[data-testid=poker-start]').length, 'a new round can start').toBe(1);
    });

    it('when another editor opens a revealed round later then they can still write the estimate', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(
        round({
          state: PokerRoundState.REVEALED,
          facilitatorId: 'id-bob',
          result: { votes: [], distribution: [], suggestion: '?' },
        }),
      );

      expect(buttonTexts(), 'no reveal for others').not.toContain('Reveal votes');
      buttonByText(fixture, 'Close without estimate').click();

      expect(story.read().pokerRoundId, 'released').toBeNull();
      expect(story.read().estimate, 'no estimate from ?').toBeNull();
    });

    it('when a round was cancelled elsewhere then an editor can detach it from the card', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round({ state: PokerRoundState.CANCELLED }));

      buttonByText(fixture, 'Detach the round from the card').click();

      expect(story.read().pokerRoundId, 'detached').toBeNull();
    });
  });

  describe('lifecycle', () => {
    it('when the dialog closes then polling stops', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round());
      expect(poker.pollerCount, 'polling').toBe(1);

      buttonByLabel(fixture, 'Close planning poker').click();
      expect(closed, 'closed').toBe(1);
      fixture.destroy();

      expect(poker.pollerCount, 'stopped').toBe(0);
    });

    it('when the story card is deleted then the dialog closes', async () => {
      await render();

      board.deleteItems([id]);

      expect(closed, 'closed').toBe(1);
    });
  });

  describe('mode', () => {
    it('when a card dialog has no block id then it closes and never acts as a quick dialog', async () => {
      await render({ withoutBlockId: true });

      expect(closed, 'closed').toBe(1);
      expect(all(fixture, '[data-testid=start-quick-round]').length, 'no quick start').toBe(0);
    });
  });

  describe('quick rounds', () => {
    /** A quick round as the server answers it: no storyBlockId. */
    const quickRound = (overrides: Partial<PokerRound> = {}): PokerRound => {
      const r = aPokerRound({ title: 'Quick round', ...overrides });
      delete (r as { storyBlockId?: string }).storyBlockId;
      return r;
    };
    const REVEALED: Partial<PokerRound> = {
      state: PokerRoundState.REVEALED,
      version: 3,
      result: {
        votes: [
          { displayName: 'Alice Admin', guest: false, value: '3' },
          { displayName: 'Gina', guest: true, value: '5' },
          { displayName: 'Bob', guest: false, value: '5' },
        ],
        average: 4.33,
        median: 5,
        distribution: [
          { value: '3', count: 1 },
          { value: '5', count: 2 },
        ],
        suggestion: '5',
      },
    };

    it('when an editor starts a quick round then it has no card, the title is prefilled and the document is untouched', async () => {
      await render({ quick: {} });
      let updates = 0;
      board.doc.on('update', () => updates++);

      expect(all(fixture, '[data-testid=quick-marker]').length, 'marked as quick').toBe(1);
      expect(
        (el().querySelector('input[type=text]') as HTMLInputElement).value,
        'prefilled title',
      ).toBe('Quick round');
      await submit();
      const create = expectRequest('POST', ROUNDS, 'create');
      expect(create.request.body, 'no storyBlockId').toEqual({
        title: 'Quick round',
        deck: { kind: 'FIBONACCI' },
      });
      create.flush(quickRound(), { status: 201, statusText: 'Created' });
      await settle();
      await poll(quickRound());

      expect(all(fixture, '[data-testid=poker-open]').length, 'round shown').toBe(1);
      expect(updates, 'nothing written into the document').toBe(0);
      expect(story.read().pokerRoundId ?? null, 'no card announces it').toBeNull();
      expect(
        poker.openRounds().map((r) => r.id),
        'in the open list',
      ).toEqual([ROUND_ID]);
    });

    it('when the facilitator reveals a quick round then the result shows, nothing is saved, and a new round can start', async () => {
      await render({ quick: { roundId: ROUND_ID } });
      await poll(quickRound());
      let updates = 0;
      board.doc.on('update', () => updates++);

      buttonByText(fixture, 'Reveal votes').click();
      await settle();
      expectRequest('POST', `${ROUND}/reveal`, 'reveal').flush(quickRound(REVEALED));
      await settle();

      const text = textOf(fixture);
      expect(text, 'average').toContain('4.33');
      expect(text, 'median').toContain('Median');
      expect(all(fixture, '[aria-label=Distribution] li').length, 'distribution').toBe(2);
      expect(all(fixture, '[data-testid=quick-note]').length, 'saved nowhere').toBe(1);
      expect(buttonTexts(), 'no estimate to save').not.toContain('Use 5 as the estimate');
      expect(updates, 'nothing written').toBe(0);
      expect(buttonTexts(), 'new round and close').toEqual(
        expect.arrayContaining(['New round', 'Close']),
      );

      buttonByText(fixture, 'New round').click();
      await settle();
      expect(all(fixture, '[data-testid=poker-start]').length, 'start form again').toBe(1);
      expect(poker.pollerCount, 'the old round is let go').toBe(0);
      buttonByLabel(fixture, 'Close planning poker').click();
      expect(closed, 'closed').toBe(1);
    });

    it('when a quick round is cancelled then nothing is written and a new round or closing is offered', async () => {
      await render({ quick: { roundId: ROUND_ID } });
      await poll(quickRound());

      buttonByText(fixture, 'Cancel round').click();
      await settle();
      expectRequest('POST', `${ROUND}/cancel`, 'cancel').flush(
        quickRound({ state: PokerRoundState.CANCELLED, version: 2 }),
      );
      await settle();

      expect(all(fixture, '[data-testid=poker-cancelled]').length, 'cancelled').toBe(1);
      expect(buttonTexts(), 'no detaching from a card').not.toContain(
        'Detach the round from the card',
      );
      expect(buttonTexts(), 'new round and close').toEqual(
        expect.arrayContaining(['New round', 'Close']),
      );
    });

    it('when the quick dialog is pointed at a round on a card then it is ignored - binding rule', async () => {
      await render({ quick: { roundId: ROUND_ID } });
      await poll(round());

      expect(all(fixture, '[data-testid=poker-open]').length, 'not shown').toBe(0);
      expect(all(fixture, '[data-testid=poker-start]').length, 'the start form instead').toBe(1);
      expect(poker.pollerCount, 'released').toBe(0);
    });

    it('when a guest on a comment link opens a quick round then they vote but never close it or start one', async () => {
      await render({ guest: GrantRole.COMMENTER, quick: { roundId: ROUND_ID } });
      await poll(quickRound());

      buttonByLabel(fixture, '5').click();
      await settle();
      expectRequest('PUT', `${ROUND}/vote`, 'vote').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expect(textOf(fixture), 'own vote from the 204').toContain('You voted 5');
      expect(buttonTexts(), 'no reveal').not.toContain('Reveal votes');
      expect(buttonTexts(), 'no cancel').not.toContain('Cancel round');
      expect(buttonTexts(), 'no new round').not.toContain('New round');
    });

    it('when a guest sees a revealed quick round then the result shows with Close only', async () => {
      await render({ guest: GrantRole.COMMENTER, quick: { roundId: ROUND_ID } });
      await poll(quickRound(REVEALED));

      expect(all(fixture, '[data-testid=poker-result]').length, 'result').toBe(1);
      expect(buttonTexts(), 'no new round for a guest').not.toContain('New round');
      buttonByText(fixture, 'Close').click();
      expect(closed, 'closed').toBe(1);
    });
  });

  describe('the table', () => {
    const REVEALED_ROUND: Partial<PokerRound> = {
      state: PokerRoundState.REVEALED,
      version: 2,
      result: {
        votes: [
          { displayName: 'Anna', guest: false, value: '5' },
          { displayName: 'Ben', guest: false, value: '8' },
          { displayName: 'Gina', guest: true, value: '5' },
        ],
        average: 6,
        median: 5,
        distribution: [
          { value: '5', count: 2 },
          { value: '8', count: 1 },
        ],
        suggestion: '5',
      },
    };

    it('when votes are open then voted cards show a striped back, the others an empty outline, and no value', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(
        round({
          participants: [
            { displayName: 'Anna', guest: false, voted: true },
            { displayName: 'Ben', guest: false, voted: false },
          ],
        }),
      );

      const seats = all(fixture, '[data-testid=participants] li');
      expect(seats.length, 'one card per participant').toBe(2);
      expect(seats[0]?.querySelector('.poker-back'), 'voted: striped back').not.toBeNull();
      expect(seats[1]?.querySelector('.poker-back'), 'not voted: outline only').toBeNull();
      expect(seats[1]?.querySelector('.border-dashed'), 'dashed outline').not.toBeNull();
      expect(all(fixture, '[data-testid=card-face]').length, 'no face before the reveal').toBe(0);
      expect(textOf(fixture), 'kicker').toContain('Story');
      expect(el().querySelector('[data-testid=poker-title]')?.textContent, 'title').toContain(
        'Login',
      );
      expect(el().querySelector('[data-testid=poker-deck]')?.textContent?.trim(), 'deck line').toBe(
        'Deck: Fibonacci · 0, 1, 2, 3, 5, 8, 13, 21, ?, ☕',
      );
      expect(textOf(fixture), 'count').toContain('1 of 2 voted');
      expect(buttonTexts(), 'the big button').toContain('Reveal votes');
    });

    it('when the round is revealed then the cards turn over to the values and the suggestion is highlighted', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round(REVEALED_ROUND));

      const faces = all(fixture, '[data-testid=card-face]');
      expect(
        faces.map((f) => f.textContent?.trim()),
        'values',
      ).toEqual(['5', '8', '5']);
      expect(all(fixture, '.poker-side-back').length, 'every card has its back').toBe(3);
      expect(
        el().querySelector('[data-testid=revealed-cards]')?.classList.contains('poker-animated'),
        'flips',
      ).toBe(true);
      expect(
        all(fixture, '.poker-flip-inner').map((f) => f.style.getPropertyValue('--i')),
        'staggered',
      ).toEqual(['0', '1', '2']);
      const suggestion = el().querySelector('[data-testid=suggestion]');
      expect(suggestion?.textContent, 'suggestion tile').toContain('Suggestion');
      expect(suggestion?.textContent, 'suggestion value').toContain('5');
      expect(suggestion?.className, 'highlighted').toContain('yellow');
      expect(textOf(fixture), 'average and median').toMatch(/Average\s*6\s*Median\s*5/);
      expect(el().querySelector('[aria-label="Ben voted 8"]'), 'named for readers').not.toBeNull();
      expect(buttonTexts(), 'the suggestion is the default estimate').toContain(
        'Use 5 as the estimate',
      );
    });

    it('when the estimate is written then the dialog shows "Estimate set"', async () => {
      await render({ pokerRoundId: ROUND_ID });
      await poll(round(REVEALED_ROUND));

      buttonByText(fixture, 'Use 5 as the estimate').click();
      await settle();

      expect(el().querySelector('[data-testid=estimate-set]')?.textContent?.trim(), 'done').toBe(
        'Estimate set: 5 points',
      );
      expect(buttonTexts(), 'nothing left to save').not.toContain('Use 5 as the estimate');
    });

    it('when the user prefers reduced motion then the cards are swapped without the flip', async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })) as unknown as typeof window.matchMedia;
      try {
        await render({ pokerRoundId: ROUND_ID });
        await poll(round(REVEALED_ROUND));
      } finally {
        window.matchMedia = original;
      }

      expect(
        el().querySelector('[data-testid=revealed-cards]')?.classList.contains('poker-animated'),
        'no flip',
      ).toBe(false);
      expect(
        all(fixture, '[data-testid=card-face]').map((f) => f.textContent?.trim()),
        'the values are there at once',
      ).toEqual(['5', '8', '5']);
    });

    it('when a quick round is shown then the kicker says so and no story is named', async () => {
      await render({ quick: { roundId: ROUND_ID } });
      const quick = aPokerRound({ title: 'Lunch', participants: [] });
      delete (quick as { storyBlockId?: string }).storyBlockId;
      await poll(quick);

      expect(textOf(fixture), 'kicker').toContain('Quick round');
      expect(el().querySelector('[data-testid=poker-title]')?.textContent, 'title').toContain(
        'Lunch',
      );
      expect(textOf(fixture), 'no story kicker').not.toContain('Story');
    });
  });

  describe('custom decks', () => {
    it('when custom values are parsed then the contract rules apply', () => {
      expect(parseCustomDeck('1, 2, 3'), 'ok').toEqual(['1', '2', '3']);
      expect(parseCustomDeck('1'), 'too few').toContain('Between 2 and 20');
      expect(parseCustomDeck('123456789, 2'), 'too long').toContain('1 to 8 characters');
      expect(parseCustomDeck('é, é'), 'same after NFC').toBe('Each value only once.');
    });
  });

  function buttonTexts(): string[] {
    return Array.from(el().querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');
  }
});
