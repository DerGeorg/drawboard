import { inputBinding } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Avatar } from './avatar';

describe('Avatar', () => {
  describe('rendering', () => {
    it('when given a name and a colour then it shows the initials on that colour with the name as label', async () => {
      const fixture = TestBed.createComponent(Avatar, {
        bindings: [
          inputBinding('name', () => 'Alice Admin'),
          inputBinding('color', () => '#e8590c'),
        ],
      });
      await fixture.whenStable();

      const el = (fixture.nativeElement as HTMLElement).querySelector('[role=img]') as HTMLElement;
      expect(el.textContent, 'initials').toBe('AA');
      expect(el.getAttribute('aria-label'), 'label').toBe('Alice Admin');
      expect(el.style.backgroundColor, 'colour').toBe('rgb(232, 89, 12)');
    });

    it('when the size is small then the circle is smaller', async () => {
      const fixture = TestBed.createComponent(Avatar, {
        bindings: [inputBinding('name', () => 'Bob'), inputBinding('size', () => 'sm' as const)],
      });
      await fixture.whenStable();

      const el = (fixture.nativeElement as HTMLElement).querySelector('[role=img]') as HTMLElement;
      expect(el.classList.contains('size-7'), 'small circle').toBe(true);
    });
  });
});
