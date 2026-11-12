import { TestBed } from '@angular/core/testing';

import { aProblem } from '../test/fixtures';
import { ErrorMessages } from './error-messages';

describe('ErrorMessages', () => {
  let messages: ErrorMessages;

  beforeEach(() => {
    messages = TestBed.inject(ErrorMessages);
  });

  describe('text', () => {
    it('when the code is known then its user text is returned', () => {
      const text = messages.text(
        aProblem({ code: 'FORBIDDEN', status: 403, detail: 'Access Denied' }),
      );

      expect(text, 'text for FORBIDDEN').toBe('You do not have permission for this action.');
    });

    it.each([
      ['LIBRARY_BOARD_NOT_FOUND', 404, 'This board does not exist (any more).'],
      ['LIBRARY_BOARD_ACCESS_DENIED', 403, 'You do not have access to this board.'],
    ])('when the code is %s then the board text is returned', (code, status, expected) => {
      const text = messages.text(aProblem({ code, status, detail: 'technical detail' }));

      expect(text, `text for ${code}`).toBe(expected);
    });

    it('when an upload is refused for its type or quota then the files text is returned', () => {
      expect(
        messages.text(aProblem({ code: 'FILES_TYPE_NOT_ALLOWED', status: 415 })),
        'type',
      ).toContain('This file type is not allowed');
      expect(
        messages.text(aProblem({ code: 'FILES_QUOTA_EXCEEDED', status: 413 })),
        'quota',
      ).toContain('quota');
    });

    it('when a plugin upload is refused then the params fill the text', () => {
      expect(
        messages.text(
          aProblem({
            code: 'PLUGINS_VERSION_EXISTS',
            status: 409,
            params: { installedVersion: '1.2.0' },
          }),
        ),
        'version',
      ).toBe('Version 1.2.0 of this plugin is installed: upload a higher version.');
      expect(
        messages.text(
          aProblem({
            code: 'PLUGINS_ARCHIVE_INVALID',
            status: 400,
            params: { reason: 'UNSAFE_PATH' },
          }),
        ),
        'archive',
      ).toBe('The plugin ZIP is not valid (UNSAFE_PATH).');
    });

    it('when the code is unknown then the detail of the server is returned', () => {
      const text = messages.text(
        aProblem({ code: 'BOARD_SOMETHING_NEW', detail: 'Something new.' }),
      );

      expect(text, 'text for an unknown code').toBe('Something new.');
    });

    it('when the code is unknown given no detail then the title is returned', () => {
      const text = messages.text(aProblem({ code: 'BOARD_SOMETHING_NEW', title: 'Teapot' }));

      expect(text, 'text without detail').toBe('Teapot');
    });
  });
});
