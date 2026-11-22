import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { Theme } from '../../../services/theme';
import { provideFakeAuth } from '../../../test/fake-auth';
import { all } from '../../../test/dom';
import { provideHttpTesting } from '../../../test/http-testing';
import { ThemeSwitch } from './theme-switch';

describe('ThemeSwitch', () => {
  let fixture: ComponentFixture<ThemeSwitch>;
  let theme: Theme;

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), provideFakeAuth().providers],
    });
    theme = TestBed.inject(Theme);
    fixture = TestBed.createComponent(ThemeSwitch);
    await fixture.whenStable();
  }

  const items = (): HTMLButtonElement[] => all<HTMLButtonElement>(fixture, '[role=menuitemradio]');
  const checked = (): string[] =>
    items()
      .filter((b) => b.getAttribute('aria-checked') === 'true')
      .map((b) => b.textContent?.replace(/\s+/g, ' ').trim() ?? '');

  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  describe('rendering', () => {
    it('when rendered then System, Light and Dark are radio items of a labelled group', async () => {
      await render();

      expect(
        all(fixture, '[role=group]').map((g) => g.getAttribute('aria-label')),
        'group',
      ).toEqual(['Theme']);
      expect(
        items().map((b) => b.textContent?.replace(/\s+/g, ' ').trim().replace(/ On$/, '')),
        'items',
      ).toEqual(['System', 'Light', 'Dark']);
    });

    it('when no choice was made then System is the checked one and the only one in the tab order', async () => {
      await render();

      expect(checked(), 'checked').toEqual(['System On']);
      expect(
        items().map((b) => b.getAttribute('tabindex')),
        'tab stops',
      ).toEqual(['0', '-1', '-1']);
    });
  });

  describe('choosing', () => {
    it('when Dark is clicked then it is applied and marked', async () => {
      await render();

      items()[2]?.click();
      await fixture.whenStable();

      expect(theme.mode(), 'mode').toBe('DARK');
      expect(checked(), 'checked').toEqual(['Dark On']);
      expect(document.documentElement.dataset['theme'], 'attribute').toBe('dark');
    });

    it('when a choice is made then the chosen mode is announced', async () => {
      await render();
      const announced: string[] = [];
      fixture.componentInstance.chosen.subscribe((mode) => announced.push(mode));

      items()[1]?.click();
      await fixture.whenStable();

      expect(announced, 'announced').toEqual(['LIGHT']);
    });

    it('when the arrow keys are used then the choice and the focus move with them', async () => {
      await render();
      document.body.appendChild(fixture.nativeElement as HTMLElement);
      items()[0]?.focus();

      items()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await fixture.whenStable();
      expect(theme.mode(), 'after ArrowDown').toBe('LIGHT');
      expect(document.activeElement, 'focus on Light').toBe(items()[1]);

      items()[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      items()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await fixture.whenStable();
      expect(theme.mode(), 'wraps around to Dark').toBe('DARK');
      (fixture.nativeElement as HTMLElement).remove();
    });

    it('when another key is pressed then nothing changes', async () => {
      await render();

      items()[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      await fixture.whenStable();

      expect(theme.mode(), 'mode').toBe('SYSTEM');
    });
  });
});
