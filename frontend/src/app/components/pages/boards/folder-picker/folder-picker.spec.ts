import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, buttonByText } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { aFolder } from '../../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../../test/http-testing';
import { FolderPicker } from './folder-picker';

describe('FolderPicker', () => {
  let fixture: ComponentFixture<FolderPicker>;
  let picked: (string | null)[];

  async function render(current: string | null, excluded: string[] = []): Promise<void> {
    picked = [];
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(FolderPicker, {
      bindings: [
        inputBinding('current', () => current),
        inputBinding('excluded', () => new Set(excluded)),
        outputBinding<string | null>('picked', (id) => picked.push(id)),
      ],
    });
    await settle();
    expectRequest('GET', '/api/folders', 'list own folders').flush({
      items: [
        aFolder({ id: 'w', name: 'Work' }),
        aFolder({ id: 't', name: 'Team', parentId: 'w' }),
      ],
    });
    await settle();
    await fixture.whenStable();
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('targets', () => {
    it('when shown then the top level and the folders are offered, nested ones indented', async () => {
      await render('w');

      const rows = all(fixture, 'li button').map((b) => b.textContent?.trim());
      expect(rows, 'targets').toEqual(['My boards (top level)', 'Work', 'Team']);
      expect(all<HTMLElement>(fixture, 'li button')[2].style.paddingLeft, 'indent of Team').toBe(
        '2rem',
      );
    });

    it('when a folder is clicked then picked carries its id', async () => {
      await render(null);

      buttonByText(fixture, 'Team').click();

      expect(picked, 'picked').toEqual(['t']);
    });

    it('when the top level is clicked then picked carries null', async () => {
      await render('w');

      buttonByText(fixture, 'My boards (top level)').click();

      expect(picked, 'picked').toEqual([null]);
    });

    it('when a folder is the current place or excluded then its button is disabled', async () => {
      await render('w', ['t']);

      expect(buttonByText(fixture, 'Work').disabled, 'current place').toBe(true);
      expect(buttonByText(fixture, 'Team').disabled, 'excluded').toBe(true);
      expect(buttonByText(fixture, 'My boards (top level)').disabled, 'top level').toBe(false);
    });
  });
});
