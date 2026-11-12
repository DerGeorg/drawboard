import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, buttonByLabel } from '../../../test/dom';
import { Modal } from './modal';

describe('Modal', () => {
  let fixture: ComponentFixture<Modal>;
  let closed: number;
  let opener: HTMLButtonElement;

  async function render(wide = false): Promise<void> {
    closed = 0;
    opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    fixture = TestBed.createComponent(Modal, {
      bindings: [
        inputBinding('heading', () => 'Hello'),
        inputBinding('wide', () => wide),
        outputBinding('closed', () => closed++),
      ],
    });
    await fixture.whenStable();
  }

  afterEach(() => opener.remove());

  describe('rendering', () => {
    it('when shown then the dialog is modal and labelled by its heading', async () => {
      await render();

      const dialog = all(fixture, '[role=dialog]')[0];
      const heading = all(fixture, 'h2')[0];
      expect(heading.textContent, 'heading').toBe('Hello');
      expect(dialog.getAttribute('aria-modal'), 'modal').toBe('true');
      expect(dialog.getAttribute('aria-labelledby'), 'label').toBe(heading.id);
    });

    it('when wide then the box is wider', async () => {
      await render(true);

      expect(all(fixture, '.modal-box')[0].className, 'box').toContain('max-w-2xl');
    });
  });

  describe('focus', () => {
    it('when shown then focus moves to the close button', async () => {
      await render();

      expect(document.activeElement, 'focused element').toBe(buttonByLabel(fixture, 'Close'));
    });

    it('when destroyed then focus returns to what opened it', async () => {
      await render();

      fixture.destroy();

      expect(document.activeElement, 'focused element').toBe(opener);
    });
  });

  describe('closing', () => {
    it('when the close button is clicked then closed is emitted', async () => {
      await render();

      buttonByLabel(fixture, 'Close').click();

      expect(closed, 'closed events').toBe(1);
    });

    it('when the backdrop is clicked then closed is emitted', async () => {
      await render();

      buttonByLabel(fixture, 'Close dialog').click();

      expect(closed, 'closed events').toBe(1);
    });

    it('when Escape is pressed inside then closed is emitted', async () => {
      await render();

      buttonByLabel(fixture, 'Close').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );

      expect(closed, 'closed events').toBe(1);
    });
  });
});
