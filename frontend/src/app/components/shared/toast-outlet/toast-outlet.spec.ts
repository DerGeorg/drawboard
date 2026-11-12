import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Toasts } from '../../../services/toasts';
import { all, buttonByLabel, textOf } from '../../../test/dom';
import { ToastOutlet } from './toast-outlet';

describe('ToastOutlet', () => {
  let fixture: ComponentFixture<ToastOutlet>;
  let toasts: Toasts;

  beforeEach(async () => {
    fixture = TestBed.createComponent(ToastOutlet);
    toasts = TestBed.inject(Toasts);
    await fixture.whenStable();
  });

  describe('rendering', () => {
    it('when an error with a request id is pushed then an alert shows message and id', async () => {
      toasts.error(
        'You do not have permission for this action.',
        '4bf92f3577b34da6a3ce929d0e0e4736',
      );
      await fixture.whenStable();

      const alerts = all(fixture, '[role=alert]');
      expect(alerts.length, 'number of alerts').toBe(1);
      expect(alerts[0].textContent, 'text of the alert').toContain('You do not have permission');
      expect(textOf(fixture), 'request id in the toast').toContain(
        '4bf92f3577b34da6a3ce929d0e0e4736',
      );
    });

    it('when a success is pushed then it is a status message without a request id', async () => {
      toasts.success('Board created.');
      await fixture.whenStable();

      expect(all(fixture, '[role=status]').length, 'number of status messages').toBe(1);
      expect(all(fixture, '[data-testid=toast-request-id]').length, 'request ids shown').toBe(0);
    });
  });

  describe('dismiss', () => {
    it('when Dismiss is clicked then the toast disappears', async () => {
      toasts.success('Board created.');
      await fixture.whenStable();

      buttonByLabel(fixture, 'Dismiss').click();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=toast]').length, 'toasts after dismissing').toBe(0);
    });
  });
});
