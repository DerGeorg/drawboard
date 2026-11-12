import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { buildFolderTree } from '../../../../util/folder-tree';
import { all, buttonByLabel, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { TEAM_FOLDER_ID, WORK_FOLDER_ID, aFolder } from '../../../../test/fixtures';
import { provideHttpTesting, settle } from '../../../../test/http-testing';
import { flushFolders } from '../testing/library';
import { FolderTreeNode } from './folder-tree-node';

/** The details of one tree row; flows through the menu are covered in folder-tree.spec.ts. */
describe('FolderTreeNode', () => {
  let fixture: ComponentFixture<FolderTreeNode>;
  const work = aFolder();
  const team = aFolder({ id: TEAM_FOLDER_ID, name: 'Team', parentId: WORK_FOLDER_ID });

  async function render(active?: string): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(FolderTreeNode, {
      bindings: [
        inputBinding('node', () => buildFolderTree([work, team])[0]),
        inputBinding('active', () => active),
      ],
    });
    await settle();
    await flushFolders([work, team]);
    await fixture.whenStable();
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('rendering', () => {
    it('when the folder has a subfolder then it is nested below with a deeper indent', async () => {
      await render();

      const rows = all<HTMLElement>(fixture, 'li > div');
      expect(textOf(fixture), 'names').toContain('Team');
      expect(rows[1].style.paddingLeft, 'indent of the child').toBe('1.125rem');
    });

    it('when the folder is the active one then it is marked as the current page', async () => {
      await render(WORK_FOLDER_ID);

      expect(all(fixture, 'a[aria-current=page]').length, 'current links').toBe(1);
    });

    it('when the toggle is clicked twice then the subfolders hide and show again', async () => {
      await render();

      buttonByLabel(fixture, 'Collapse Work').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'collapsed').not.toContain('Team');

      buttonByLabel(fixture, 'Expand Work').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'expanded').toContain('Team');
    });
  });
});
