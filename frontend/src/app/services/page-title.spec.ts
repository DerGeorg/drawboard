import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { NotFound } from '../components/pages/errors/not-found/not-found';
import { PageTitle } from './page-title';

describe('PageTitle', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'titled', component: NotFound, title: 'Boards' },
          { path: 'untitled', component: NotFound },
        ]),
        { provide: TitleStrategy, useClass: PageTitle },
      ],
    });
  });

  describe('updateTitle', () => {
    it('when the route has a title then the app name is appended', async () => {
      const harness = await RouterTestingHarness.create();

      await harness.navigateByUrl('/titled');

      expect(TestBed.inject(Title).getTitle(), 'document title').toBe('Boards · Drawboard');
    });

    it('when the route has no title then only the app name is shown', async () => {
      const harness = await RouterTestingHarness.create();

      await harness.navigateByUrl('/untitled');

      expect(TestBed.inject(Title).getTitle(), 'document title').toBe('Drawboard');
    });
  });
});
