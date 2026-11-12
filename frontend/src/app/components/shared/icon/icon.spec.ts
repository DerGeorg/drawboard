import { inputBinding } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ICONS } from './icons';
import { Icon } from './icon';

describe('Icon', () => {
  describe('rendering', () => {
    it('when given a name then the svg draws that icon and is hidden from assistive technology', async () => {
      const fixture = TestBed.createComponent(Icon, {
        bindings: [inputBinding('name', () => 'undo' as const)],
      });
      await fixture.whenStable();

      const svg = (fixture.nativeElement as HTMLElement).querySelector('svg');
      expect(svg?.querySelector('path')?.getAttribute('d'), 'path data').toBe(ICONS.undo);
      expect(svg?.getAttribute('aria-hidden'), 'aria-hidden').toBe('true');
    });
  });
});
