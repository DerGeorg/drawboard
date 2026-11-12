import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { aProblem } from '../../../test/fixtures';
import { buttonByText, textOf } from '../../../test/dom';
import { toApiError } from '../../../util/api-error';
import { LoadError } from './load-error';

describe('LoadError', () => {
  const error = signal<unknown>(undefined);
  let retries = 0;
  let fixture: ComponentFixture<LoadError>;

  beforeEach(async () => {
    retries = 0;
    error.set(
      toApiError(
        new HttpErrorResponse({
          status: 404,
          error: aProblem({ code: 'LIBRARY_BOARD_NOT_FOUND', status: 404, requestId: 'req-404' }),
          headers: new HttpHeaders(),
        }),
      ),
    );
    fixture = TestBed.createComponent(LoadError, {
      bindings: [
        inputBinding('error', error),
        inputBinding('subject', () => 'the board'),
        outputBinding('retry', () => retries++),
      ],
    });
    await fixture.whenStable();
  });

  describe('rendering', () => {
    it('when the error is an ApiError then its message and request id are shown', () => {
      expect(textOf(fixture), 'alert text').toContain('Could not load the board.');
      expect(textOf(fixture), 'message of the error code').toContain(
        'This board does not exist (any more).',
      );
      expect(textOf(fixture), 'request id').toContain('req-404');
    });

    it('when the error is something else then a generic reason without id is shown', async () => {
      error.set(new Error('boom'));
      await fixture.whenStable();

      expect(textOf(fixture), 'generic alert text').toContain('Unexpected error.');
      expect(textOf(fixture), 'no request id').not.toContain('Request id');
    });
  });

  describe('retry', () => {
    it('when Try again is clicked then retry is emitted once', () => {
      buttonByText(fixture, 'Try again').click();

      expect(retries, 'retry emissions').toBe(1);
    });
  });
});
