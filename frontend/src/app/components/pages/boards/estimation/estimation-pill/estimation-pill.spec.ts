import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  BoardRole,
  EstimationSessionState,
  EstimationSessionSummary,
  GrantRole,
} from '@apps/drawboard-api';

import { all, buttonByText, textOf } from '../../../../../test/dom';
import { provideFakeAuth } from '../../../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../../test/http-testing';
import { SESSION_ID, aSummary } from '../../testing/estimation';
import { BoardEstimation } from '../board-estimation';
import { EstimationPill } from './estimation-pill';

const SESSIONS = `/api/boards/${SPRINT_BOARD_ID}/estimation-sessions`;

describe('EstimationPill', () => {
  let fixture: ComponentFixture<EstimationPill>;
  let estimation: BoardEstimation;
  let opened: string[];
  let creates: number;

  interface Setup {
    role?: BoardRole;
    guest?: GrantRole;
    readOnly?: boolean;
    items?: EstimationSessionSummary[];
  }

  async function render(setup: Setup = {}): Promise<void> {
    const fake = provideFakeAuth();
    if (setup.guest) {
      fake.auth.signInAsGuest({ name: 'G', role: setup.guest, kind: 'BOARD', id: SPRINT_BOARD_ID });
    } else {
      fake.auth.signIn('alice');
    }
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers, BoardEstimation],
    });
    opened = [];
    creates = 0;
    estimation = TestBed.inject(BoardEstimation);
    estimation.open(SPRINT_BOARD_ID, setup.role ?? BoardRole.EDITOR);
    await settle();
    if (setup.guest !== GrantRole.VIEWER) {
      expectRequest('GET', SESSIONS, 'list').flush({ items: setup.items ?? [aSummary()] });
    }
    fixture = TestBed.createComponent(EstimationPill, {
      bindings: [
        inputBinding('readOnly', () => setup.readOnly ?? false),
        outputBinding<string>('open', (id) => opened.push(id)),
        outputBinding('create', () => creates++),
      ],
    });
    await fixture.whenStable();
  }

  function pill(): HTMLButtonElement {
    return (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid=estimation-pill]',
    ) as HTMLButtonElement;
  }

  describe('indicator', () => {
    it('when a session is active then the count shows and a pick opens it', async () => {
      await render();
      const list = vi.spyOn(estimation, 'loadSessions');

      expect(pill().textContent?.replace(/\s+/g, ' ').trim(), 'count').toBe('1 session');
      pill().click();
      await fixture.whenStable();
      expect(list, 'the menu lists again (throttled)').toHaveBeenCalledTimes(1);
      expect(textOf(fixture), 'mode and state').toContain('Rotation · lobby · 2 cards');
      all<HTMLButtonElement>(fixture, 'li button')
        .find((b) => b.textContent?.includes('Sprint 42'))
        ?.click();

      expect(opened, 'opened').toEqual([SESSION_ID]);
    });

    it('when the caller sits in a running session then the chip says "in estimation"', async () => {
      await render({ items: [aSummary({ state: EstimationSessionState.MOVING })] });

      expect(
        all(fixture, '[data-testid=in-estimation]').length,
        'chip from the server list (me.seated)',
      ).toBe(1);
    });

    it('when the guest has a view link then nothing shows and nothing is asked', async () => {
      await render({ guest: GrantRole.VIEWER, role: BoardRole.VIEWER });

      expect(all(fixture, '[data-testid=estimation-pill]').length, 'hidden').toBe(0);
    });
  });

  describe('menu', () => {
    it('when an editor opens it then a new session can be started', async () => {
      await render({ items: [] });

      pill().click();
      await fixture.whenStable();
      expect(textOf(fixture), 'empty').toContain('No active sessions.');
      buttonByText(fixture, 'New estimation session').click();

      expect(creates, 'create').toBe(1);
    });

    it('when a guest or a read-only board opens it then nobody can create one', async () => {
      await render({ guest: GrantRole.EDITOR, role: BoardRole.EDITOR });
      pill().click();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=new-estimation-session]').length, 'guest').toBe(0);
      expect(textOf(fixture), 'guests cannot list finished sessions').not.toContain(
        'Finished sessions',
      );
    });

    it('when a member looks at finished sessions then CLOSED is listed and can be opened', async () => {
      await render({ role: BoardRole.VIEWER });
      pill().click();
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=new-estimation-session]').length, 'viewer').toBe(0);

      buttonByText(fixture, 'Finished sessions').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'loading').toContain('Loading…');
      await settle();
      expectRequest('GET', SESSIONS, 'closed').flush({
        items: [aSummary({ id: 'done', title: 'Sprint 41', state: EstimationSessionState.DONE })],
      });
      await fixture.whenStable();
      all<HTMLButtonElement>(fixture, 'li button')
        .find((b) => b.textContent?.includes('Sprint 41'))
        ?.click();

      expect(opened, 'opened a finished one').toEqual(['done']);
    });

    it('when the user clicks elsewhere or presses Escape then the menu closes', async () => {
      await render();
      pill().click();
      await fixture.whenStable();

      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await fixture.whenStable();
      expect(all(fixture, 'ul').length, 'closed by a click outside').toBe(0);

      pill().click();
      await fixture.whenStable();
      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();
      expect(all(fixture, 'ul').length, 'closed by Escape').toBe(0);
    });

    it('when the board is read-only then an editor cannot create either', async () => {
      await render({ readOnly: true });
      pill().click();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=new-estimation-session]').length, 'read-only').toBe(0);
    });
  });
});
