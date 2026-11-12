import { inputBinding } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BoardRole } from '@apps/drawboard-api';

import { linkByText, textOf } from '../../../../test/dom';
import { WORK_FOLDER_ID, aFolder } from '../../../../test/fixtures';
import { FolderCard } from './folder-card';

describe('FolderCard', () => {
  async function render(view: 'mine' | 'shared', role: BoardRole = BoardRole.OWNER) {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(FolderCard, {
      bindings: [inputBinding('folder', () => aFolder({ role })), inputBinding('view', () => view)],
    });
    await fixture.whenStable();
    return fixture;
  }

  describe('links', () => {
    it('when shown in my space then the name links to the folder in the mine view', async () => {
      const fixture = await render('mine');

      expect(linkByText(fixture, 'Work').getAttribute('href'), 'link').toBe(
        `/boards?view=mine&folder=${WORK_FOLDER_ID}`,
      );
    });

    it('when shown under shared with me then the link keeps the shared view and the role is shown', async () => {
      const fixture = await render('shared', BoardRole.VIEWER);

      expect(linkByText(fixture, 'Work').getAttribute('href'), 'link').toBe(
        `/boards?view=shared&folder=${WORK_FOLDER_ID}`,
      );
      expect(textOf(fixture), 'role').toContain('Viewer');
    });
  });
});
