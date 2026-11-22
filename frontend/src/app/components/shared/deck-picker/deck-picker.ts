import { Component, input } from '@angular/core';
import { FormField, FieldTree, validate } from '@angular/forms/signals';
import type { SchemaPath } from '@angular/forms/signals';

import { isValidEstimate } from '@apps/drawboard-engine';
import { FieldErrors } from '../field-errors/field-errors';

/** The kinds of deck the picker offers (`PokerDeckKind`). */
export type DeckChoice = 'FIBONACCI' | 'TSHIRT' | 'CUSTOM';

/** The fixed decks of the contract (`PokerDeckKind`), in the order the UI shows them. */
export const DECKS: Readonly<Record<'FIBONACCI' | 'TSHIRT', readonly string[]>> = {
  FIBONACCI: ['0', '1', '2', '3', '5', '8', '13', '21', '?', 'coffee'],
  TSHIRT: ['XS', 'S', 'M', 'L', 'XL', '?'],
};

/** A custom deck typed as "1, 2, 4, 8": the values, or an error text. */
export function parseCustomDeck(text: string): string[] | string {
  const values = text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  if (values.length < 2 || values.length > 20) {
    return 'Between 2 and 20 values, separated by commas.';
  }
  if (!values.every(isValidEstimate)) {
    return 'Each value has 1 to 8 characters, like 1, 2, 4 or XL.';
  }
  if (new Set(values.map((v) => v.normalize('NFC'))).size !== values.length) {
    return 'Each value only once.';
  }
  return values;
}

/** Schema rule for the custom field: the typed values must form a valid deck while CUSTOM. */
export function validateCustomDeck(deck: SchemaPath<DeckChoice>, custom: SchemaPath<string>): void {
  validate(custom, ({ value, valueOf }) => {
    if (valueOf(deck) !== 'CUSTOM') {
      return undefined;
    }
    const parsed = parseCustomDeck(value());
    return typeof parsed === 'string' ? { kind: 'deck', message: parsed } : undefined;
  });
}

/**
 * The deck selection of an estimation start form: the choice (Fibonacci, T-shirt, custom) and,
 * for custom, the comma-separated values. The two Signal Forms fields belong to the parent's
 * form (so it submits and validates them); use `validateCustomDeck` in its schema.
 */
@Component({
  selector: 'drawboard-deck-picker',
  imports: [FormField, FieldErrors],
  templateUrl: './deck-picker.html',
  host: { class: 'contents' },
})
export class DeckPicker {
  readonly deck = input.required<FieldTree<DeckChoice>>();
  readonly custom = input.required<FieldTree<string>>();
  /** Prefix of the ids of the controls (several pickers on one page). */
  readonly idPrefix = input.required<string>();
}
