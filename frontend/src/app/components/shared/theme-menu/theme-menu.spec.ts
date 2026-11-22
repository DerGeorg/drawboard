import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { GifConsentStore } from '../../../services/gif-consent';
import { Theme } from '../../../services/theme';
import { all, buttonByLabel } from '../../../test/dom';
import { provideFakeAuth } from '../../../test/fake-auth';
import { provideHttpTesting } from '../../../test/http-testing';
import { provideTestRuntimeConfig } from '../../../test/runtime-config';
import { ThemeMenu } from './theme-menu';

describe('ThemeMenu', () => {
  let fixture: ComponentFixture<ThemeMenu>;

  async function render(gifsEnabled = false, auth = provideFakeAuth()): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpTesting(),
        auth.providers,
        provideTestRuntimeConfig({ gifsEnabled }),
      ],
    });
    fixture = TestBed.createComponent(ThemeMenu);
    await fixture.whenStable();
  }

  const menu = (): HTMLElement | undefined => all(fixture, '[role=menu]')[0];

  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  describe('GIF switch hint for admins (G3)', () => {
    const hint = (): HTMLElement | undefined => all(fixture, '[data-testid=gifs-half-on]')[0];

    async function open(frontend: boolean, backend: boolean, admin: boolean): Promise<void> {
      const auth = provideFakeAuth();
      auth.auth.signIn('alice', 'Alice', admin, false, 'SYSTEM', backend);
      await render(frontend, auth);
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();
    }

    it('when an admin sees the frontend switch on and the backend key missing then the hint shows', async () => {
      await open(true, false, true);

      expect(hint()?.textContent, 'text').toContain('GIF search is half switched on');
    });

    it('when an admin sees the backend key but the frontend switch off then the hint shows', async () => {
      await open(false, true, true);

      expect(hint(), 'hint').toBeDefined();
    });

    it('when both agree then there is no hint', async () => {
      await open(true, true, true);
      expect(hint(), 'both on').toBeUndefined();
    });

    it('when both are off then there is no hint', async () => {
      await open(false, false, true);
      expect(hint(), 'both off').toBeUndefined();
    });

    it('when the user is no admin then there is no hint although they disagree', async () => {
      await open(true, false, false);
      expect(hint(), 'no admin').toBeUndefined();
    });
  });

  describe('GIF consent (G10)', () => {
    const forget = (): HTMLElement | undefined => all(fixture, '[data-testid=forget-gifs]')[0];

    it('when nothing was agreed then there is nothing to forget', async () => {
      await render(true);
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      expect(forget(), 'no entry').toBeUndefined();
    });

    it('when the viewer agreed "always" then "Forget GIF consent" shows and takes it back', async () => {
      await render(true);
      const consent = TestBed.inject(GifConsentStore);
      consent.allowAlways();
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      expect(forget()?.textContent?.trim(), 'entry').toBe('Forget GIF consent');
      forget()?.click();
      await fixture.whenStable();

      expect(consent.allowed('b1'), 'consent gone').toBe(false);
      expect(window.localStorage.getItem('drawboard.gifs.consent'), 'storage cleared').toBeNull();
      expect(menu(), 'menu closed').toBeUndefined();
    });

    it('when "Load" was agreed for a board then the entry shows too', async () => {
      await render(true);
      TestBed.inject(GifConsentStore).allowBoard('b1');
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      expect(forget(), 'entry').toBeDefined();
    });

    it('when the instance has no GIFs then the entry never shows', async () => {
      await render(false);
      TestBed.inject(GifConsentStore).allowAlways();
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      expect(forget(), 'no entry').toBeUndefined();
    });
  });

  describe('opening', () => {
    it('when created then the menu is closed and the button announces a menu', async () => {
      await render();

      const button = buttonByLabel(fixture, 'Theme');
      expect(button.getAttribute('aria-haspopup'), 'popup').toBe('menu');
      expect(button.getAttribute('aria-expanded'), 'expanded').toBe('false');
      expect(menu(), 'menu').toBeUndefined();
    });

    it('when the button is clicked then the menu opens with the three choices', async () => {
      await render();

      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      expect(menu()?.getAttribute('aria-label'), 'menu label').toBe('Theme');
      expect(all(fixture, '[role=menuitemradio]').length, 'choices').toBe(3);
      expect(buttonByLabel(fixture, 'Theme').getAttribute('aria-expanded'), 'expanded').toBe(
        'true',
      );
    });

    it('when a choice is made then it applies and the menu closes', async () => {
      await render();
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      all<HTMLButtonElement>(fixture, '[role=menuitemradio]')[2]?.click();
      await fixture.whenStable();

      expect(TestBed.inject(Theme).mode(), 'mode').toBe('DARK');
      expect(menu(), 'menu').toBeUndefined();
    });

    it('when Escape is pressed or the backdrop is clicked then the menu closes', async () => {
      await render();
      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();
      expect(menu(), 'after Escape').toBeUndefined();

      buttonByLabel(fixture, 'Theme').click();
      await fixture.whenStable();
      all<HTMLButtonElement>(fixture, 'button[aria-hidden=true]')[0]?.click();
      await fixture.whenStable();
      expect(menu(), 'after the backdrop').toBeUndefined();
    });
  });

  describe('icon', () => {
    it('when the theme is dark then the button shows the moon, otherwise the sun', async () => {
      await render();
      const path = (): string | null =>
        buttonByLabel(fixture, 'Theme').querySelector('path')?.getAttribute('d') ?? null;
      const light = path();

      await TestBed.inject(Theme).set('DARK');
      await fixture.whenStable();

      expect(path(), 'dark icon').not.toBe(light);
      expect(path(), 'moon').toContain('A8 8');
    });
  });
});
