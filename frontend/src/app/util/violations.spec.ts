import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';

import { fieldAt, violationsToFieldErrors } from './violations';

describe('violations', () => {
  function aForm() {
    const model = signal({
      title: '',
      address: { street: '' },
      items: [{ name: '' }, { name: '' }],
    });
    return TestBed.runInInjectionContext(() => form(model));
  }

  describe('fieldAt', () => {
    it('when the path is nested or indexed then the matching field is found', () => {
      const root = aForm();

      expect(fieldAt(root, 'title'), 'top-level field').toBe(root.title);
      expect(fieldAt(root, 'address.street'), 'nested field').toBe(root.address.street);
      expect(fieldAt(root, 'items[1].name'), 'indexed field').toBe(root.items[1].name);
    });

    it('when the path does not exist then undefined is returned', () => {
      expect(fieldAt(aForm(), 'nope.deeper'), 'unknown path').toBeUndefined();
    });
  });

  describe('violationsToFieldErrors', () => {
    it('when a constraint is known then its friendly text replaces the backend message', () => {
      const root = aForm();

      const errors = violationsToFieldErrors(root, [
        { field: 'title', code: 'Pattern', message: 'must match "^\\s*\\S[\\s\\S]*"' },
        { field: 'unknown', code: 'Custom', message: 'Backend says no.' },
      ]);

      expect(errors, 'field errors').toEqual([
        {
          kind: 'server:Pattern',
          message: 'Must contain at least one character that is not a space.',
          fieldTree: root.title,
        },
        { kind: 'server:Custom', message: 'Backend says no.', fieldTree: undefined },
      ]);
    });
  });
});
