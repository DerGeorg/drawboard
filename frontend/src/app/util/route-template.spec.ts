import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { NotFound } from '../components/pages/errors/not-found/not-found';
import { routeTemplate } from './route-template';

describe('routeTemplate', () => {
  describe('template', () => {
    it('when a parameterised child route is active then the template, not the URL, is returned', async () => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            { path: 'boards', children: [{ path: ':boardId', component: NotFound }] },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();

      await harness.navigateByUrl('/boards/0192?x=1');

      const root = TestBed.inject(Router).routerState.snapshot.root;
      expect(routeTemplate(root), 'route template').toBe('/boards/:boardId');
    });
  });
});
