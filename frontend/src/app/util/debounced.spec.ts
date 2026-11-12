import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { debounced } from './debounced';

describe('debounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('following the source', () => {
    it('when the source changes then the value follows only after the delay', () => {
      const source = signal('a');
      const out = runInInjectionContext(TestBed.inject(Injector), () => debounced(source, 300));
      expect(out(), 'initial value').toBe('a');

      source.set('ab');
      TestBed.tick();
      vi.advanceTimersByTime(299);
      expect(out(), 'before the delay').toBe('a');

      vi.advanceTimersByTime(1);
      expect(out(), 'after the delay').toBe('ab');
    });

    it('when the source changes again within the delay then only the last value arrives', () => {
      const source = signal('a');
      const out = runInInjectionContext(TestBed.inject(Injector), () => debounced(source, 300));

      source.set('ab');
      TestBed.tick();
      vi.advanceTimersByTime(200);
      source.set('abc');
      TestBed.tick();
      vi.advanceTimersByTime(200);
      expect(out(), 'in between').toBe('a');

      vi.advanceTimersByTime(100);
      expect(out(), 'last value').toBe('abc');
    });
  });
});
