import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole, GrantRole, PokerRound } from '@apps/drawboard-api';

import { STORY_TYPE, newStoryProps, BoardDoc } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../../board-engine/engine';
import { all, buttonByText } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../../test/http-testing';
import { aPokerRound } from '../../testing/poker';
import { BoardPoker } from '../board-poker';
import { BoardPokerRounds } from './board-poker-rounds';

describe('BoardPokerRounds', () => {
  let fixture: ComponentFixture<BoardPokerRounds>;
  let board: BoardDoc;
  let engine: BoardEngine;
  let opened: string[];
  let quickOpened: string[];
  let starts: number;
  let poker: BoardPoker;
  let id: string;

  interface Setup {
    role?: BoardRole;
    readOnly?: boolean;
    /** The open rounds the server lists (default: one on the card, one on a lost card). */
    items?: (storyId: string) => PokerRound[];
  }

  /** A quick round as the server lists it: no storyBlockId. */
  function quickRound(overrides: Partial<PokerRound> = {}): PokerRound {
    const r = aPokerRound({ id: 'q1', title: 'Quick round', ...overrides });
    delete (r as { storyBlockId?: string }).storyBlockId;
    return r;
  }

  async function render(guest?: GrantRole, setup: Setup = {}): Promise<void> {
    const fake = provideFakeAuth();
    if (guest) {
      fake.auth.signInAsGuest({ name: 'G', role: guest, kind: 'BOARD', id: SPRINT_BOARD_ID });
    } else {
      fake.auth.signIn('alice');
    }
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardPoker],
    });
    board = new BoardDoc();
    engine = new BoardEngine(document.createElement('div'), board);
    id = board.addBlock({ type: STORY_TYPE, x: 0, y: 0, w: 1, h: 1, props: newStoryProps() });
    opened = [];
    quickOpened = [];
    starts = 0;
    poker = TestBed.inject(BoardPoker);
    poker.open(SPRINT_BOARD_ID, setup.role ?? BoardRole.EDITOR);
    await settle();
    if (guest !== GrantRole.VIEWER) {
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/poker-rounds`, 'list').flush({
        items: setup.items?.(id) ?? [
          aPokerRound({ storyBlockId: id, title: 'Login' }),
          aPokerRound({ id: 'r2', storyBlockId: 'gone', title: 'Lost card' }),
        ],
      });
    }
    fixture = TestBed.createComponent(BoardPokerRounds, {
      bindings: [
        inputBinding('engine', () => engine),
        inputBinding('readOnly', () => setup.readOnly ?? false),
        outputBinding<string>('open', (b) => opened.push(b)),
        outputBinding<string>('openQuick', (r) => quickOpened.push(r)),
        outputBinding('startQuick', () => starts++),
      ],
    });
    await fixture.whenStable();
  }

  afterEach(() => {
    engine.destroy();
    board.destroy();
  });

  describe('indicator', () => {
    it('when rounds are open then the count shows and a pick opens the card', async () => {
      await render();

      const pill = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid=open-rounds]',
      ) as HTMLButtonElement;
      expect(pill.textContent?.trim(), 'count').toBe('2 open estimations');
      pill.click();
      await fixture.whenStable();
      const item = (text: string): HTMLButtonElement =>
        all<HTMLButtonElement>(fixture, 'li button').find((b) =>
          b.textContent?.includes(text),
        ) as HTMLButtonElement;
      expect(item('Lost card').disabled, 'card not on the board').toBe(true);
      item('Login').click();

      expect(opened, 'opened').toEqual([id]);
      expect(engine.selection.list(), 'card selected').toEqual([id]);
    });

    it('when the guest has a view link then nothing shows and nothing is asked', async () => {
      await render(GrantRole.VIEWER);

      expect(all(fixture, '[data-testid=open-rounds]').length, 'hidden').toBe(0);
    });

    it('when a quick round is open then it is listed with a marker and a pick opens it, not a card', async () => {
      await render(undefined, { items: () => [quickRound()] });

      buttonByText(fixture, '1 open estimation').click();
      await fixture.whenStable();
      const item = all<HTMLButtonElement>(fixture, 'li button').find((b) =>
        b.textContent?.includes('Quick round'),
      ) as HTMLButtonElement;
      expect(item.textContent, 'marker').toContain('quick round');
      expect(item.disabled, 'no card needed').toBe(false);
      item.click();

      expect(quickOpened, 'opened the quick round').toEqual(['q1']);
      expect(opened, 'no card').toEqual([]);
      expect(engine.selection.list(), 'nothing selected').toEqual([]);
    });

    it('when nothing is open then an editor still sees the pill and can start a quick round', async () => {
      await render(undefined, { items: () => [] });
      const list = vi.spyOn(poker, 'loadOpenRounds');

      buttonByText(fixture, 'Estimations').click();
      await fixture.whenStable();

      expect(list, 'opening the menu lists again (throttled)').toHaveBeenCalledTimes(1);
      expect((fixture.nativeElement as HTMLElement).textContent, 'empty').toContain(
        'No open estimations.',
      );
      buttonByText(fixture, 'Start a quick round').click();
      await fixture.whenStable();
      expect(starts, 'start asked for').toBe(1);
      expect(all(fixture, 'ul').length, 'menu closed').toBe(0);
    });

    it('when a commenter, a guest or a read-only editor opens the menu then no quick round can be started', async () => {
      for (const [guest, setup] of [
        [undefined, { role: BoardRole.COMMENTER }],
        [GrantRole.EDITOR, {}],
        [undefined, { readOnly: true }],
      ] as const) {
        await render(guest, { ...setup, items: () => [quickRound()] });
        buttonByText(fixture, '1 open estimation').click();
        await fixture.whenStable();

        expect(
          all(fixture, '[data-testid=start-quick-round]').length,
          `no start: ${guest ?? JSON.stringify(setup)}`,
        ).toBe(0);
        expect(all(fixture, 'li button').length, 'the quick round is listed').toBe(1);
        fixture.destroy();
        engine.destroy();
        board.destroy();
        TestBed.resetTestingModule();
      }
    });

    it('when someone clicks elsewhere then the menu closes', async () => {
      await render();
      buttonByText(fixture, '2 open estimations').click();
      await fixture.whenStable();

      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await fixture.whenStable();

      expect(all(fixture, 'ul').length, 'closed').toBe(0);
    });
  });
});
