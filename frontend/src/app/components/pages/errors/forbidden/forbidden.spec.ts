import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { linkByText, textOf } from '../../../../test/dom';
import { Forbidden } from './forbidden';

describe('Forbidden', () => {
  describe('rendering', () => {
    it('when shown then it explains the missing access and links back to my boards', async () => {
      TestBed.configureTestingModule({ providers: [provideRouter([])] });
      const fixture = TestBed.createComponent(Forbidden);
      await fixture.whenStable();

      expect(textOf(fixture), 'page text').toContain('No permission');
      expect(linkByText(fixture, 'Back to my boards').getAttribute('href'), 'back link').toBe(
        '/boards',
      );
    });
  });
});
