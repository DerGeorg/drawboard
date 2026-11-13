import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { buttonByText, textOf } from '../../../../test/dom';
import { TemplateFilesDialog, megabytes } from './template-files-dialog';

describe('TemplateFilesDialog', () => {
  let fixture: ComponentFixture<TemplateFilesDialog>;
  const chosen = vi.fn();
  const closed = vi.fn();

  beforeEach(async () => {
    chosen.mockClear();
    closed.mockClear();
    fixture = TestBed.createComponent(TemplateFilesDialog, {
      bindings: [
        inputBinding('count', () => 3),
        inputBinding('bytes', () => 12_400_000),
        outputBinding('chosen', chosen),
        outputBinding('closed', closed),
      ],
    });
    await fixture.whenStable();
  });

  describe('question', () => {
    it('when it opens then the number and total size of the files are shown', () => {
      expect(textOf(fixture), 'text').toContain('3 files (12.4 MB together)');
    });

    it('when Copy with files is clicked then true is chosen', () => {
      buttonByText(fixture, 'Copy with files').click();

      expect(chosen, 'chosen').toHaveBeenCalledWith(true);
    });

    it('when Copy without files is clicked then false is chosen', () => {
      buttonByText(fixture, 'Copy without files').click();

      expect(chosen, 'chosen').toHaveBeenCalledWith(false);
    });

    it('when the dialog is closed then closed is emitted and nothing is chosen', () => {
      buttonByText(fixture, 'Cancel').click();

      expect(closed, 'closed').toHaveBeenCalledTimes(1);
      expect(chosen, 'chosen').not.toHaveBeenCalled();
    });
  });

  describe('megabytes', () => {
    it('when bytes are formatted then one decimal of decimal megabytes is shown', () => {
      expect(megabytes(1_500_000), 'text').toBe('1.5 MB');
    });
  });
});
