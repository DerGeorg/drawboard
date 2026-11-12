import { HttpTestingController } from '@angular/common/http/testing';
import { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { routes } from '../config/router';
import { App } from './app';
import { NotFound } from './components/pages/errors/not-found/not-found';
import { BoardList } from './components/pages/boards/board-list/board-list';
import { BoardPage } from './components/pages/boards/board-page/board-page';
import { flushFolders } from './components/pages/boards/testing/library';
import { fakeBoardCollab } from './components/pages/boards/testing/fake-board-collab';
import { FakeAuth, provideFakeAuth, signedInAsAlice } from './test/fake-auth';
import { all, textOf } from './test/dom';
import { SPRINT_BOARD_ID, aBoard, aBoardPage } from './test/fixtures';
import { expectRequest, provideHttpTesting, settle } from './test/http-testing';

/** The shell and the global router (src/config/router.ts) with the real domain routes. */
describe('App', () => {
  function configure(auth: { providers: Provider[] }): void {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes, withComponentInputBinding()),
        provideHttpTesting(),
        auth.providers,
      ],
    });
    // the board page's live connection is not part of these routing tests
    TestBed.overrideComponent(BoardPage, fakeBoardCollab);
  }

  afterEach(() => {
    const http = TestBed.inject(HttpTestingController);
    // an open board reads the enabled plugins
    http.match('/api/plugins').forEach((r) => r.flush({ items: [] }));
    // and its open planning poker rounds
    http.match((r) => r.url.endsWith('/poker-rounds')).forEach((r) => r.flush({ items: [] }));
    http.verify();
  });

  describe('layout', () => {
    it('when rendered then header, page outlet and footer are there', async () => {
      configure(signedInAsAlice());
      const fixture = TestBed.createComponent(App);
      await fixture.whenStable();

      expect(all(fixture, 'drawboard-header').length, 'headers').toBe(1);
      expect(all(fixture, 'main router-outlet').length, 'outlets in main').toBe(1);
      expect(textOf(fixture), 'footer text').toContain('Version 0.0.0-test');
    });
  });

  describe('full-window layout', () => {
    it('when the library or a board is open then header and footer are hidden, and shown again on other pages', async () => {
      configure(signedInAsAlice());
      const fixture = TestBed.createComponent(App);
      const harness = await RouterTestingHarness.create();

      await harness.navigateByUrl(`/boards/${SPRINT_BOARD_ID}`, BoardPage);
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());
      await fixture.whenStable();
      expect(all(fixture, 'drawboard-header').length, 'headers in the editor').toBe(0);
      expect(all(fixture, 'drawboard-footer').length, 'footers in the editor').toBe(0);

      await harness.navigateByUrl('/boards', BoardList);
      await settle();
      expectRequest('GET', '/api/boards', 'list boards').flush(aBoardPage());
      await flushFolders();
      await fixture.whenStable();
      expect(all(fixture, 'drawboard-header').length, 'headers on the list').toBe(0);

      await harness.navigateByUrl('/nowhere', NotFound);
      await fixture.whenStable();
      expect(all(fixture, 'drawboard-header').length, 'headers on an error page').toBe(1);
    });
  });

  describe('routing', () => {
    it('when / is opened then the board list is shown', async () => {
      configure(signedInAsAlice());
      const harness = await RouterTestingHarness.create();

      const page = await harness.navigateByUrl('/', BoardList);
      await settle();
      expectRequest('GET', '/api/boards', 'list boards').flush(aBoardPage());
      await flushFolders();

      expect(page, 'routed page').toBeInstanceOf(BoardList);
      expect(TestBed.inject(Router).url, 'URL after the redirect').toBe('/boards');
    });

    it('when alice opens a board then the board page is shown', async () => {
      configure(signedInAsAlice());
      const harness = await RouterTestingHarness.create();

      const page = await harness.navigateByUrl(`/boards/${SPRINT_BOARD_ID}`, BoardPage);
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());

      expect(page, 'routed page').toBeInstanceOf(BoardPage);
      expect(page.boardId(), 'board id from the URL').toBe(SPRINT_BOARD_ID);
    });

    it('when an unknown URL is opened then the not-found page is shown', async () => {
      configure(signedInAsAlice());
      const harness = await RouterTestingHarness.create();

      expect(await harness.navigateByUrl('/nowhere', NotFound), 'routed page').toBeInstanceOf(
        NotFound,
      );
    });

    it('when nobody is signed in then the login starts with the requested URL', async () => {
      const fake = provideFakeAuth();
      const auth: FakeAuth = fake.auth;
      configure(fake);
      const harness = await RouterTestingHarness.create();

      await harness.navigateByUrl('/boards/new-thing');

      expect(auth.loginCalls, 'login calls').toEqual(['/boards/new-thing']);
    });
  });
});
