import {
  Component,
  ElementRef,
  afterNextRender,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';
import { FormField, FormRoot, form, maxLength, pattern, required } from '@angular/forms/signals';

import { FieldErrors } from '../field-errors/field-errors';

interface NameDraft {
  name: string;
}

let nextId = 0;

/**
 * A one-field inline form (new folder, rename): a labelled text field, Save and Cancel. The
 * field is focused when the form appears. Rules mirror the contract (1-200 characters, not
 * blank); `save` carries the trimmed name.
 */
@Component({
  selector: 'drawboard-name-form',
  imports: [FormField, FormRoot, FieldErrors],
  templateUrl: './name-form.html',
  host: { '(keydown.escape)': 'onEscape($event)' },
})
export class NameForm {
  static readonly maxLength = 200;

  /** Visible to screen readers only, e.g. "Name of the folder". */
  readonly label = input.required<string>();
  readonly value = input('');
  readonly save = output<string>();
  readonly dismissed = output();

  protected readonly inputId = `name-form-${nextId++}`;
  private readonly draft = linkedSignal<NameDraft>(() => ({ name: this.value() }));
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  protected readonly nameForm = form(
    this.draft,
    (path) => {
      required(path.name, { message: 'Required.' });
      pattern(path.name, /\S/, { message: 'Required.' });
      maxLength(path.name, NameForm.maxLength, {
        message: `At most ${NameForm.maxLength} characters.`,
      });
    },
    {
      submission: {
        action: () => {
          const name = this.draft().name.trim();
          if (name !== '') {
            this.save.emit(name);
          }
          return Promise.resolve(undefined);
        },
      },
    },
  );

  constructor() {
    afterNextRender(() => {
      this.field()?.nativeElement.focus();
      this.field()?.nativeElement.select();
    });
  }

  protected onEscape(event: Event): void {
    event.stopPropagation();
    this.dismissed.emit();
  }
}
