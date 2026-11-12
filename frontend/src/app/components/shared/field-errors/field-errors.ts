import { Component, computed, input } from '@angular/core';
import { FieldTree } from '@angular/forms/signals';

/**
 * The errors of one Signal Forms field - client rules and server violations alike - once the
 * user has touched the field (or submitted the form). Link it with aria-describedby.
 */
@Component({
  selector: 'drawboard-field-errors',
  templateUrl: './field-errors.html',
})
export class FieldErrors {
  readonly field = input.required<FieldTree<string>>();

  protected readonly errors = computed(() => {
    const state = this.field()();
    return state.touched() ? state.errors() : [];
  });
}
