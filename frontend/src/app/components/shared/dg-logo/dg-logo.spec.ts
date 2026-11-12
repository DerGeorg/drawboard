import { inputBinding, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { DgLogo } from './dg-logo';

describe('DgLogo', () => {
  describe('size', () => {
    it('when no size is given then the mark is 28 px high', async () => {
      const fixture = TestBed.createComponent(DgLogo);
      await fixture.whenStable();

      const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
      expect(svg?.getAttribute('height'), 'default height of the mark').toBe('28');
    });

    it('when a size is bound then it becomes the height', async () => {
      const size = signal(40);
      const fixture = TestBed.createComponent(DgLogo, { bindings: [inputBinding('size', size)] });
      await fixture.whenStable();

      const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
      expect(svg?.getAttribute('height'), 'bound height of the mark').toBe('40');
      expect(svg?.getAttribute('aria-label'), 'accessible name of the mark').toBe('DerGeorg');
    });
  });
});
