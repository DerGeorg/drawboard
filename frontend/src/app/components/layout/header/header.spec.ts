import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { FakeAuth, provideFakeAuth } from '../../../test/fake-auth';
import { all, buttonByText, textOf } from '../../../test/dom';
import { provideTestRuntimeConfig } from '../../../test/runtime-config';
import { Header } from './header';

describe('Header', () => {
  let fixture: ComponentFixture<Header>;
  let auth: FakeAuth;

  async function render(environment = 'dev', admin = false): Promise<void> {
    const fake = provideFakeAuth();
    auth = fake.auth;
    auth.signIn('alice', 'Alice Admin', admin);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'boards', children: [] }]),
        fake.providers,
        provideTestRuntimeConfig({ environment }),
      ],
    });
    fixture = TestBed.createComponent(Header);
    await fixture.whenStable();
  }

  describe('admin navigation', () => {
    it('when an instance admin is signed in then the navigation links to the plugins', async () => {
      await render('dev', true);

      expect(
        all(fixture, 'a').map((a) => a.textContent?.trim()),
        'links',
      ).toContain('Plugins');
    });

    it('when someone else is signed in then there is no plugins link', async () => {
      await render();

      expect(all(fixture, 'a[href="/admin/plugins"]').length, 'no link').toBe(0);
    });
  });

  describe('user', () => {
    it('when alice is signed in then her display name and Sign out are shown', async () => {
      await render();

      expect(all(fixture, '[data-testid=current-user]')[0]?.textContent, 'user name').toBe(
        'Alice Admin',
      );
      expect(buttonByText(fixture, 'Sign out'), 'Sign out button').toBeTruthy();
    });

    it('when the profile is not loaded yet then no name is shown but Sign out is', async () => {
      await render();
      await auth.logout();
      auth.signInWithoutProfile();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=current-user]').length, 'user name').toBe(0);
      expect(buttonByText(fixture, 'Sign out'), 'Sign out button').toBeTruthy();
    });

    it('when Sign out is clicked then the session ends', async () => {
      await render();

      buttonByText(fixture, 'Sign out').click();
      await fixture.whenStable();

      expect(auth.logoutCalls, 'logout calls').toBe(1);
      expect(all(fixture, '[data-testid=current-user]').length, 'user name after sign out').toBe(0);
    });
  });

  describe('environment', () => {
    it('when running on dev then a dev badge is shown', async () => {
      await render('dev');

      expect(textOf(fixture), 'header text on dev').toContain('dev');
      expect(all(fixture, '[data-testid=environment]').length, 'environment badges').toBe(1);
    });

    it('when running on prod then no badge is shown', async () => {
      await render('prod');

      expect(all(fixture, '[data-testid=environment]').length, 'environment badges on prod').toBe(
        0,
      );
    });
  });

  describe('navigation', () => {
    it('when rendered then the app name and My boards are linked to the board list', async () => {
      await render();

      const links = all<HTMLAnchorElement>(fixture, 'a').map((a) => a.getAttribute('href'));
      expect(links, 'link targets (brand, navigation)').toEqual(['/boards', '/boards']);
      expect(textOf(fixture), 'header text').toContain('Drawboard');
    });

    it('when on /boards then the My boards link is the current page', async () => {
      await render();

      await TestBed.inject(Router).navigateByUrl('/boards');
      await fixture.whenStable();

      const current = all<HTMLAnchorElement>(fixture, 'nav a').map((a) =>
        a.getAttribute('aria-current'),
      );
      expect(current, 'aria-current of My boards').toEqual(['page']);
    });
  });
});
