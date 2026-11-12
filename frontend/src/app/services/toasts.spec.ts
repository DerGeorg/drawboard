import { TestBed } from '@angular/core/testing';

import { Toasts } from './toasts';

describe('Toasts', () => {
  let toasts: Toasts;

  beforeEach(() => {
    vi.useFakeTimers();
    toasts = TestBed.inject(Toasts);
  });

  afterEach(() => vi.useRealTimers());

  describe('error', () => {
    it('when an error is pushed then it carries the request id', () => {
      toasts.error('No permission.', 'req-1');

      expect(toasts.toasts(), 'toasts after one error').toEqual([
        { id: 1, kind: 'error', message: 'No permission.', requestId: 'req-1' },
      ]);
    });

    it('when its lifetime is over then the error disappears', () => {
      toasts.error('No permission.', 'req-1');

      vi.advanceTimersByTime(Toasts.errorLifetimeMs);

      expect(toasts.toasts(), 'toasts after the lifetime').toEqual([]);
    });
  });

  describe('success', () => {
    it('when a success is shown then it disappears sooner than an error', () => {
      toasts.success('Saved.');
      toasts.error('Failed.');

      vi.advanceTimersByTime(Toasts.successLifetimeMs);

      expect(
        toasts.toasts().map((t) => t.kind),
        'kinds left after the success lifetime',
      ).toEqual(['error']);
    });
  });

  describe('dismiss', () => {
    it('when a toast is dismissed then only that one is removed', () => {
      toasts.success('One.');
      toasts.success('Two.');

      toasts.dismiss(1);

      expect(
        toasts.toasts().map((t) => t.message),
        'messages left',
      ).toEqual(['Two.']);
    });
  });
});
