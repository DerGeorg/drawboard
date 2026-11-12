import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FieldTree, form, required } from '@angular/forms/signals';

import { all } from '../../../test/dom';
import { FieldErrors } from './field-errors';

describe('FieldErrors', () => {
  let fixture: ComponentFixture<FieldErrors>;
  let title: FieldTree<string>;

  function messages(): string[] {
    return all(fixture, '[data-testid=field-error]').map((e) => e.textContent?.trim() ?? '');
  }

  beforeEach(async () => {
    const model = signal({ title: '' });
    const boardForm = TestBed.runInInjectionContext(() =>
      form(model, (path) => required(path.title, { message: 'Required.' })),
    );
    title = boardForm.title;
    fixture = TestBed.createComponent(FieldErrors, {
      bindings: [inputBinding('field', () => title)],
    });
    await fixture.whenStable();
  });

  describe('rendering', () => {
    it('when the invalid field is untouched then nothing is shown', () => {
      expect(messages(), 'messages before the first touch').toEqual([]);
    });

    it('when the invalid field is touched then its error message is shown', async () => {
      title().markAsTouched();
      await fixture.whenStable();

      expect(messages(), 'messages after touching').toEqual(['Required.']);
    });

    it('when the touched field becomes valid then the message disappears', async () => {
      title().markAsTouched();
      title().value.set('Write tests');
      await fixture.whenStable();

      expect(messages(), 'messages of a valid field').toEqual([]);
    });
  });
});
