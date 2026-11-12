import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PageInfo } from '@apps/drawboard-api';

import { all, textOf } from '../../../test/dom';
import { Pager } from './pager';

describe('Pager', () => {
  const page = signal<PageInfo>({ number: 0, size: 20, totalElements: 45, totalPages: 3 });
  let fixture: ComponentFixture<Pager>;

  function links(): { text: string; href: string | null }[] {
    return all<HTMLAnchorElement>(fixture, 'a').map((a) => ({
      text: a.textContent?.trim() ?? '',
      href: a.getAttribute('href'),
    }));
  }

  beforeEach(async () => {
    page.set({ number: 0, size: 20, totalElements: 45, totalPages: 3 });
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    fixture = TestBed.createComponent(Pager, { bindings: [inputBinding('page', page)] });
    await fixture.whenStable();
  });

  describe('rendering', () => {
    it('when on the first of three pages then only Next is offered', () => {
      expect(textOf(fixture), 'position text').toContain('Page 1 of 3');
      expect(links(), 'pager links on the first page').toEqual([
        { text: 'Next', href: '/?page=2' },
      ]);
    });

    it('when on the middle page then Previous and Next point to the neighbours', async () => {
      page.set({ number: 1, size: 20, totalElements: 45, totalPages: 3 });
      await fixture.whenStable();

      expect(links(), 'pager links on the middle page').toEqual([
        { text: 'Previous', href: '/?page=1' },
        { text: 'Next', href: '/?page=3' },
      ]);
    });

    it('when on the last page then only Previous is offered', async () => {
      page.set({ number: 2, size: 20, totalElements: 45, totalPages: 3 });
      await fixture.whenStable();

      expect(
        links().map((l) => l.text),
        'pager links on the last page',
      ).toEqual(['Previous']);
    });

    it('when everything fits on one page then no pager is shown', async () => {
      page.set({ number: 0, size: 20, totalElements: 3, totalPages: 1 });
      await fixture.whenStable();

      expect(all(fixture, 'nav').length, 'pager navigation elements').toBe(0);
    });
  });
});
