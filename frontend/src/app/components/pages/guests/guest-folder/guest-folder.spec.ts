import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole } from '@apps/drawboard-api';

import { GuestSession } from '../../../../services/guest-session';
import { all, buttonByText, textOf } from '../../../../test/dom';
import { provideFakeAuth } from '../../../../test/fake-auth';
import {
  RETRO_BOARD_ID,
  SPRINT_BOARD_ID,
  aBoard,
  aBoardPage,
  aProblem,
} from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { GuestFolder } from './guest-folder';

describe('GuestFolder', () => {
  let fixture: ComponentFixture<GuestFolder>;

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        provideHttpTesting(),
        provideFakeAuth().providers,
      ],
    });
    TestBed.inject(GuestSession).start(
      {
        accessToken: 'jwt',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        kind: 'FOLDER',
        id: 'folder-1',
        role: 'VIEWER',
        name: 'Guesty',
      },
      'link',
    );
    fixture = TestBed.createComponent(GuestFolder, {
      bindings: [inputBinding('folderId', () => 'folder-1')],
    });
    await settle();
  }

  afterEach(() => {
    TestBed.inject(GuestSession).clear();
    TestBed.inject(HttpTestingController).verify();
  });

  describe('listing', () => {
    it('when the folder has boards then they are listed by recency and open in the guest editor', async () => {
      await render();

      const request = expectRequest('GET', '/api/boards', 'boards of the folder');
      expect(request.request.params.get('folderId'), 'folder parameter').toBe('folder-1');
      request.flush(
        aBoardPage([
          aBoard({ title: 'Old', updatedAt: '2026-10-01T10:00:00Z', role: BoardRole.VIEWER }),
          aBoard({
            id: RETRO_BOARD_ID,
            title: 'New',
            updatedAt: '2026-11-05T10:00:00Z',
            role: BoardRole.VIEWER,
          }),
        ]),
      );
      await settle();
      await fixture.whenStable();

      const links = all<HTMLAnchorElement>(fixture, 'ul[aria-label=Boards] a');
      expect(
        links.map((a) => a.textContent?.trim()),
        'order',
      ).toEqual(['New', 'Old']);
      expect(links[1].getAttribute('href'), 'link').toBe(`/s/b/${SPRINT_BOARD_ID}`);
      expect(all(fixture, '[data-testid=guest-badge]').length, 'guest badge').toBe(1);
    });

    it('when the folder has no boards then the empty state is shown', async () => {
      await render();

      expectRequest('GET', '/api/boards').flush(aBoardPage([]));
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'text').toContain('There are no boards in this folder.');
    });

    it('when the listing fails then an alert with a retry is shown', async () => {
      await render();

      expectRequest('GET', '/api/boards').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('req-500');
      buttonByText(fixture, 'Try again').click();
      await settle();
      expectRequest('GET', '/api/boards').flush(aBoardPage([]));
    });
  });
});
