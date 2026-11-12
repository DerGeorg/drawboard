import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, buttonByText, typeInto } from '../../../test/dom';
import { NameForm } from './name-form';

describe('NameForm', () => {
  let fixture: ComponentFixture<NameForm>;
  let saved: string[];
  let dismissals: number;

  async function render(value = ''): Promise<void> {
    saved = [];
    dismissals = 0;
    fixture = TestBed.createComponent(NameForm, {
      bindings: [
        inputBinding('label', () => 'Name of the folder'),
        inputBinding('value', () => value),
        outputBinding<string>('save', (name) => saved.push(name)),
        outputBinding('dismissed', () => dismissals++),
      ],
    });
    await fixture.whenStable();
  }

  describe('editing', () => {
    it('when shown then the field is labelled, filled with the value and focused', async () => {
      await render('Work');

      const input = all<HTMLInputElement>(fixture, 'input')[0];
      expect(input.value, 'value').toBe('Work');
      expect(all(fixture, 'label')[0].textContent, 'label').toBe('Name of the folder');
      expect(document.activeElement, 'focus').toBe(input);
    });

    it('when a name is typed and saved then the trimmed name is emitted', async () => {
      await render();

      typeInto(fixture, 'input', '  Plans  ');
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await fixture.whenStable();

      expect(saved, 'saved names').toEqual(['Plans']);
    });

    it('when the name is blank then nothing is emitted and the error is shown', async () => {
      await render();

      typeInto(fixture, 'input', '   ');
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await fixture.whenStable();

      expect(saved, 'saved names').toEqual([]);
      expect(all(fixture, '[data-testid=field-error]').length, 'errors shown').toBeGreaterThan(0);
    });

    it('when Cancel is clicked then dismissed is emitted', async () => {
      await render();

      buttonByText(fixture, 'Cancel').click();

      expect(dismissals, 'dismissed events').toBe(1);
    });

    it('when Escape is pressed then dismissed is emitted and the event stops', async () => {
      await render();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      const stop = vi.spyOn(escape, 'stopPropagation');

      all(fixture, 'input')[0].dispatchEvent(escape);

      expect(dismissals, 'dismissed events').toBe(1);
      expect(stop, 'stopPropagation called').toHaveBeenCalled();
    });
  });
});
