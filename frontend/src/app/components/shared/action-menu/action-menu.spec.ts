import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, buttonByLabel } from '../../../test/dom';
import { ActionMenu } from './action-menu';
import { inputBinding } from '@angular/core';

describe('ActionMenu', () => {
  let fixture: ComponentFixture<ActionMenu>;

  async function render(placement: 'above' | 'below' = 'below'): Promise<void> {
    fixture = TestBed.createComponent(ActionMenu, {
      bindings: [inputBinding('label', () => 'Things'), inputBinding('placement', () => placement)],
    });
    await fixture.whenStable();
  }

  async function open(): Promise<void> {
    buttonByLabel(fixture, 'Things').click();
    await fixture.whenStable();
  }

  const menu = (): HTMLElement | undefined => all(fixture, '[role=menu]')[0];

  describe('opening', () => {
    it('when created then the menu is closed and the button is labelled', async () => {
      await render();

      expect(buttonByLabel(fixture, 'Things').getAttribute('aria-expanded'), 'expanded').toBe(
        'false',
      );
      expect(menu(), 'menu').toBeUndefined();
    });

    it('when the button is clicked then the menu opens below it, labelled like the button', async () => {
      await render();

      await open();

      expect(menu()?.getAttribute('aria-label'), 'menu label').toBe('Things');
      expect(menu()?.className, 'placement').toContain('top-full');
      expect(buttonByLabel(fixture, 'Things').getAttribute('aria-expanded'), 'expanded').toBe(
        'true',
      );
    });

    it('when the placement is above then the menu opens over the button', async () => {
      await render('above');

      await open();

      expect(menu()?.className, 'placement').toContain('bottom-full');
    });
  });

  describe('closing', () => {
    it('when an entry is clicked then the menu closes', async () => {
      await render();
      await open();
      const entry = document.createElement('button');
      entry.setAttribute('role', 'menuitem');
      menu()?.appendChild(entry);

      entry.click();
      await fixture.whenStable();

      expect(menu(), 'menu').toBeUndefined();
    });

    it('when the menu itself (not an entry) is clicked then it stays open', async () => {
      await render();
      await open();

      menu()?.click();
      await fixture.whenStable();

      expect(menu(), 'menu').toBeDefined();
    });

    it('when the backdrop is clicked then the menu closes', async () => {
      await render();
      await open();

      all(fixture, 'button[tabindex="-1"]')[0].click();
      await fixture.whenStable();

      expect(menu(), 'menu').toBeUndefined();
    });

    it('when Escape is pressed then the menu closes', async () => {
      await render();
      await open();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();

      expect(menu(), 'menu').toBeUndefined();
    });
  });
});
