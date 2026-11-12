import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { linkByText, textOf } from '../../../../test/dom';
import { NotFound } from './not-found';

describe('NotFound', () => {
  describe('rendering', () => {
    it('when shown then it says so and links back to my boards', async () => {
      TestBed.configureTestingModule({ providers: [provideRouter([])] });
      const fixture = TestBed.createComponent(NotFound);
      await fixture.whenStable();

      expect(textOf(fixture), 'page text').toContain('Page not found');
      expect(linkByText(fixture, 'Back to my boards').getAttribute('href'), 'back link').toBe(
        '/boards',
      );
    });
  });
});
