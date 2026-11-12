import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { all, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { VersionHistory } from './version-history';

describe('VersionHistory', () => {
  let fixture: ComponentFixture<VersionHistory>;
  let closed: number;
  const base = `/api/boards/${SPRINT_BOARD_ID}`;
  const versions = {
    items: [
      { id: 'v2', upToSeq: 20, createdAt: '2026-11-09T12:00:00Z', size: 5_200_000 },
      { id: 'v1', upToSeq: 10, createdAt: '2026-11-08T12:00:00Z', size: 900 },
    ],
  };

  async function render(answer: object = versions): Promise<void> {
    closed = 0;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        provideHttpTesting(),
        signedInAsAlice().providers,
      ],
    });
    fixture = TestBed.createComponent(VersionHistory, {
      bindings: [
        inputBinding('boardId', () => SPRINT_BOARD_ID),
        outputBinding('closed', () => closed++),
      ],
    });
    await settle();
    expectRequest('GET', `${base}/versions`, 'list versions').flush(answer);
    await settle();
    await fixture.whenStable();
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('listing', () => {
    it('when versions are kept then each shows its time and size, newest first', async () => {
      await render();

      const rows = all(fixture, 'ul[aria-label=Versions] > li').map((li) =>
        li.textContent?.replace(/\s+/g, ' ').trim(),
      );
      expect(rows.length, 'rows').toBe(2);
      expect(rows[0], 'newest').toContain('5.2 MB');
      expect(rows[1], 'oldest').toContain('900 B');
    });

    it('when no version is kept then the empty state explains it', async () => {
      await render({ items: [] });

      expect(all(fixture, '[data-testid=empty]').length, 'empty state').toBe(1);
    });

    it('when the list cannot be loaded then an alert with the request id is shown', async () => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: '**', children: [] }]),
          provideHttpTesting(),
          signedInAsAlice().providers,
        ],
      });
      fixture = TestBed.createComponent(VersionHistory, {
        bindings: [inputBinding('boardId', () => SPRINT_BOARD_ID)],
      });
      await settle();
      expectRequest('GET', `${base}/versions`).flush(
        aProblem({ status: 403, code: 'FORBIDDEN', requestId: 'req-403' }),
        problemResponse(403, 'Forbidden', 'req-403'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('req-403');
    });
  });

  describe('restoring', () => {
    it('when Restore is clicked then a confirmation is asked and nothing is sent', async () => {
      await render();

      buttonByText(fixture, 'Restore').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'question').toContain('Replace the board with this version?');
    });

    it('when the confirmation is cancelled then the dialog stays open', async () => {
      await render();
      buttonByText(fixture, 'Restore').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(all(fixture, '[role=group]').length, 'question').toBe(0);
      expect(closed, 'closed events').toBe(0);
    });

    it('when the restore is confirmed then it is requested and the dialog closes', async () => {
      await render();
      buttonByText(fixture, 'Restore').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Yes, restore').click();
      await settle();
      expectRequest('POST', `${base}/versions/v2/restore`, 'restore the newest').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expect(closed, 'closed events').toBe(1);
    });

    it('when the restore fails then the dialog stays open', async () => {
      await render();
      buttonByText(fixture, 'Restore').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Yes, restore').click();
      await settle();

      expectRequest('POST', `${base}/versions/v2/restore`).flush(
        aProblem({ code: 'COLLAB_VERSION_NOT_FOUND', status: 404 }),
        problemResponse(404, 'Not Found'),
      );
      await settle();

      expect(closed, 'closed events').toBe(0);
    });

    it('when Close is clicked then closed is emitted', async () => {
      await render();

      (all(fixture, 'button[aria-label=Close]')[0] as HTMLButtonElement).click();

      expect(closed, 'closed events').toBe(1);
    });
  });
});
