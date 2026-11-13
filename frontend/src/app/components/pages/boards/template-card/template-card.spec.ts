import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Board, BoardRole } from '@apps/drawboard-api';

import { signedInAsAlice } from '../../../../test/fake-auth';
import { provideHttpTesting } from '../../../../test/http-testing';
import { buttonByText, linkByText, textOf } from '../../../../test/dom';
import { SPRINT_BOARD_ID, aBoard } from '../../../../test/fixtures';
import { TemplateOwners } from '../template-owners';
import { TemplateCard } from './template-card';

describe('TemplateCard', () => {
  let fixture: ComponentFixture<TemplateCard>;
  const board = signal<Board>(aBoard({ template: true, title: 'Team retro' }));
  const busy = signal(false);
  const used = vi.fn();

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(TemplateCard, {
      bindings: [
        inputBinding('board', board),
        inputBinding('busy', busy),
        outputBinding('use', used),
      ],
    });
    await fixture.whenStable();
  }

  beforeEach(() => {
    board.set(aBoard({ template: true, title: 'Team retro' }));
    busy.set(false);
    used.mockClear();
  });

  describe('card', () => {
    it('when a template is shown then its title, age and role are there', async () => {
      board.set(aBoard({ title: 'Team retro', role: BoardRole.EDITOR }));
      await render();

      expect(textOf(fixture), 'text').toContain('Team retro');
      expect(textOf(fixture), 'age').toContain('Edited');
      expect(textOf(fixture), 'role').toContain('Editor');
    });

    it('when the template belongs to the user then it says By You', async () => {
      await render();

      expect(textOf(fixture), 'owner').toContain('By You');
    });

    it('when the template belongs to someone else and the name is known then it is shown', async () => {
      board.set(aBoard({ ownerId: 'id-bob', template: true }));
      TestBed.configureTestingModule({
        providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
      });
      vi.spyOn(TestBed.inject(TemplateOwners), 'name').mockReturnValue('Bob Builder');
      fixture = TestBed.createComponent(TemplateCard, { bindings: [inputBinding('board', board)] });
      await fixture.whenStable();

      expect(textOf(fixture), 'owner').toContain('By Bob Builder');
    });

    it('when Use is clicked then use is emitted', async () => {
      await render();

      buttonByText(fixture, 'Use').click();

      expect(used, 'use').toHaveBeenCalledTimes(1);
    });

    it('when a copy is being made then Use is disabled', async () => {
      busy.set(true);
      await render();

      expect(buttonByText(fixture, 'Use').disabled, 'disabled').toBe(true);
    });

    it('when Open is clicked then the link leads to the template board itself', async () => {
      await render();

      expect(linkByText(fixture, 'Open').getAttribute('href'), 'link').toBe(
        `/boards/${SPRINT_BOARD_ID}`,
      );
    });
  });
});
