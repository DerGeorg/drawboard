import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FieldTree, form } from '@angular/forms/signals';

import { all } from '../../../test/dom';
import { DeckChoice, DeckPicker, parseCustomDeck, validateCustomDeck } from './deck-picker';

interface Draft {
  deck: DeckChoice;
  custom: string;
}

describe('DeckPicker', () => {
  let fixture: ComponentFixture<DeckPicker>;
  let draft: FieldTree<Draft>;

  function select(): HTMLSelectElement {
    return fixture.nativeElement.querySelector('select');
  }
  function customInput(): HTMLInputElement | null {
    return fixture.nativeElement.querySelector('input');
  }

  beforeEach(async () => {
    const model = signal<Draft>({ deck: 'FIBONACCI', custom: '' });
    draft = TestBed.runInInjectionContext(() =>
      form(model, (path) => validateCustomDeck(path.deck, path.custom)),
    );
    fixture = TestBed.createComponent(DeckPicker, {
      bindings: [
        inputBinding('deck', () => draft.deck),
        inputBinding('custom', () => draft.custom),
        inputBinding('idPrefix', () => 'p1'),
      ],
    });
    await fixture.whenStable();
  });

  describe('choice', () => {
    it('when shown then the three decks are offered and the custom values are hidden', () => {
      expect(
        Array.from(select().options).map((o) => o.value),
        'decks',
      ).toEqual(['FIBONACCI', 'TSHIRT', 'CUSTOM']);
      expect(select().value, 'default').toBe('FIBONACCI');
      expect(customInput(), 'no custom input').toBeNull();
    });

    it('when a fixed deck is picked then the field follows', async () => {
      select().value = 'TSHIRT';
      select().dispatchEvent(new Event('input'));
      select().dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(draft.deck().value(), 'deck').toBe('TSHIRT');
    });
  });

  describe('custom deck', () => {
    it('when custom is picked then the values can be typed and a bad deck shows its error', async () => {
      select().value = 'CUSTOM';
      select().dispatchEvent(new Event('input'));
      select().dispatchEvent(new Event('change'));
      await fixture.whenStable();
      const input = customInput();
      expect(input, 'custom input').not.toBeNull();
      expect(input?.getAttribute('id'), 'id with prefix').toBe('p1-custom');

      input!.value = '1';
      input!.dispatchEvent(new Event('input'));
      input!.dispatchEvent(new Event('change'));
      draft.custom().markAsTouched();
      await fixture.whenStable();

      expect(
        all(fixture, '[data-testid=field-error]').map((e) => e.textContent?.trim()),
        'errors',
      ).toEqual(['Between 2 and 20 values, separated by commas.']);
    });

    it('when the deck is not custom then the typed values are not checked', () => {
      draft.custom().value.set('1');

      expect(draft.custom().errors(), 'no errors').toEqual([]);
    });
  });

  describe('parseCustomDeck', () => {
    it('when values are parsed then the contract rules apply', () => {
      expect(parseCustomDeck(' 1, 2 ,3 '), 'trimmed').toEqual(['1', '2', '3']);
      expect(parseCustomDeck('1'), 'too few').toContain('Between 2 and 20');
      expect(parseCustomDeck('123456789, 2'), 'too long').toContain('1 to 8 characters');
      expect(parseCustomDeck('a, a'), 'duplicate').toBe('Each value only once.');
    });
  });
});
