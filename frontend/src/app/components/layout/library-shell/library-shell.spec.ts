import { inputBinding, outputBinding, signal, twoWayBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { FakeAuth, provideFakeAuth } from '../../../test/fake-auth';
import { all, buttonByLabel, textOf } from '../../../test/dom';
import { provideTestRuntimeConfig } from '../../../test/runtime-config';
import { LibraryShell, LibraryView } from './library-shell';

describe('LibraryShell', () => {
  let fixture: ComponentFixture<LibraryShell>;
  let auth: FakeAuth;
  const view = signal<LibraryView>('recent');
  const search = signal('');

  let rootDrops = 0;

  async function render(environment = 'dev', admin = false): Promise<void> {
    rootDrops = 0;
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
    fixture = TestBed.createComponent(LibraryShell, {
      bindings: [
        inputBinding('view', view),
        twoWayBinding('search', search),
        outputBinding('rootDrop', () => rootDrops++),
      ],
    });
    await fixture.whenStable();
  }

  const el = (selector: string): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector(selector);

  beforeEach(() => {
    view.set('recent');
    search.set('');
  });

  describe('sidebar', () => {
    it('when rendered then Recent, My boards, Shared with me and Trash are links with their view', async () => {
      await render();

      const links = all<HTMLAnchorElement>(fixture, 'nav a');
      expect(
        links.map((a) => a.textContent?.trim()),
        'links',
      ).toEqual(['Recent', 'My boards', 'Shared with me', 'Trash']);
      expect(
        links.map((a) => a.getAttribute('href')),
        'targets',
      ).toEqual(['/boards', '/boards?view=mine', '/boards?view=shared', '/boards?view=trash']);
    });

    it('when the view is trash then Trash is the current page', async () => {
      view.set('trash');
      await render();

      const current = all(fixture, 'nav a[aria-current=page]').map((a) => a.textContent?.trim());
      expect(current, 'current entries').toEqual(['Trash']);
    });

    it('when a board card is dropped on My boards then rootDrop is emitted', async () => {
      await render();
      const mine = all(fixture, 'nav a')[1];
      const over = new Event('dragover', { cancelable: true });
      const drop = new Event('drop', { cancelable: true });

      mine.dispatchEvent(over);
      mine.dispatchEvent(drop);

      expect(over.defaultPrevented, 'dragover accepted').toBe(true);
      expect(drop.defaultPrevented, 'drop handled').toBe(true);
      expect(rootDrops, 'rootDrop events').toBe(1);
    });

    it('when a board card is dropped on another entry then nothing happens', async () => {
      await render();
      const trash = all(fixture, 'nav a')[3];
      const drop = new Event('drop', { cancelable: true });

      trash.dispatchEvent(new Event('dragover', { cancelable: true }));
      trash.dispatchEvent(drop);

      expect(drop.defaultPrevented, 'drop handled').toBe(false);
      expect(rootDrops, 'rootDrop events').toBe(0);
    });

    it('when the view is mine then My boards is the current page', async () => {
      view.set('mine');
      await render();

      const current = all(fixture, 'nav a[aria-current=page]').map((a) => a.textContent?.trim());
      expect(current, 'current entries').toEqual(['My boards']);
      expect(all(fixture, 'nav a[href="/boards?view=mine"]').length, 'link with the view').toBe(1);
    });

    it('when the environment is not prod then a badge says which one', async () => {
      await render('dev');

      expect(el('[data-testid=environment]')?.textContent, 'badge').toBe('dev');
    });

    it('when the environment is prod then there is no badge', async () => {
      await render('prod');

      expect(el('[data-testid=environment]'), 'badge').toBeNull();
    });

    it('when the menu button is clicked then the drawer opens and a link in it closes it again', async () => {
      await render();
      const sidebar = (): string => el('#library-sidebar')?.className ?? '';
      expect(sidebar(), 'closed on a phone').toContain('max-md:invisible');

      buttonByLabel(fixture, 'Open the sidebar').click();
      await fixture.whenStable();
      expect(sidebar(), 'open').toContain('translate-x-0');
      expect(
        buttonByLabel(fixture, 'Open the sidebar').getAttribute('aria-expanded'),
        'state',
      ).toBe('true');

      (all(fixture, 'nav a')[0] as HTMLElement).click();
      await fixture.whenStable();
      expect(sidebar(), 'closed again').toContain('max-md:invisible');
    });

    it('when Escape is pressed then the drawer closes', async () => {
      await render();
      buttonByLabel(fixture, 'Open the sidebar').click();
      await fixture.whenStable();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();

      expect(el('#library-sidebar')?.className, 'sidebar').toContain('max-md:invisible');
    });
  });

  describe('search', () => {
    it('when a text is typed then the search model follows', async () => {
      await render();
      const input = el('#library-search') as HTMLInputElement;

      input.value = 'retro';
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();

      expect(search(), 'search text').toBe('retro');
    });

    it('when the field is labelled then it is reachable for assistive technology', async () => {
      await render();

      expect(el('label[for=library-search]')?.textContent, 'label').toBe('Search boards');
    });
  });

  describe('user menu', () => {
    it('when alice is signed in then her name is shown and the menu offers Sign out', async () => {
      await render();
      expect(el('[data-testid=current-user]')?.textContent, 'name').toBe('Alice Admin');

      buttonByLabel(fixture, 'Account menu').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'username').toContain('Signed in as alice');
      (all(fixture, '[role=menuitem]')[0] as HTMLElement).click();

      expect(auth.logoutCalls, 'logout calls').toBe(1);
    });

    it('when an instance admin opens the menu then it links to the plugins', async () => {
      await render('dev', true);

      buttonByLabel(fixture, 'Account menu').click();
      await fixture.whenStable();

      expect(el('a[href="/admin/plugins"]')?.textContent, 'link').toContain('Plugins');
    });

    it('when someone else opens the menu then there is no plugins link', async () => {
      await render();

      buttonByLabel(fixture, 'Account menu').click();
      await fixture.whenStable();

      expect(el('a[href="/admin/plugins"]'), 'no link').toBeNull();
    });

    it('when the backdrop is clicked then the menu closes', async () => {
      await render();
      buttonByLabel(fixture, 'Account menu').click();
      await fixture.whenStable();

      (el('button.fixed.inset-0.z-10') as HTMLElement).click();
      await fixture.whenStable();

      expect(el('[role=menu]'), 'menu').toBeNull();
    });

    it('when the profile is not loaded then there is no user menu', async () => {
      await render();
      await auth.logout();
      auth.signInWithoutProfile();
      await fixture.whenStable();

      expect(el('[data-testid=current-user]'), 'name').toBeNull();
    });
  });
});
