import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { encodeDataUrlFragment } from '../../../../../board-engine/io/data-url';
import { BoardDoc } from '../../../../../board-engine/model/board-doc';
import { Toasts } from '../../../../services/toasts';
import { all, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { aBoard } from '../../../../test/fixtures';
import { provideHttpTesting } from '../../../../test/http-testing';
import { BoardImporter } from '../../boards/board-importer';
import { OpenFromLink } from './open-from-link';

describe('OpenFromLink', () => {
  let fixture: ComponentFixture<OpenFromLink>;
  let save: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.spyOn>;

  function linkTo(): string {
    const board = new BoardDoc();
    board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, text: 'from a link' });
    return encodeDataUrlFragment(board, 'Shared plan');
  }

  async function render(fragment: string): Promise<void> {
    window.history.replaceState(null, '', `/open#${fragment}`);
    save = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpTesting(),
        signedInAsAlice().providers,
        { provide: BoardImporter, useValue: { save } },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(OpenFromLink);
    await fixture.whenStable();
  }

  afterEach(() => {
    // a link opens no collaboration connection and calls no API at all
    TestBed.inject(HttpTestingController).verify();
    window.history.replaceState(null, '', '/');
  });

  describe('a valid link', () => {
    it('when opened then the board is shown read-only with the "not saved" banner', async () => {
      await render(linkTo());

      expect(textOf(fixture), 'banner').toContain('Opened from a link, not saved');
      expect(textOf(fixture), 'title').toContain('Shared plan');
      expect(all(fixture, '[data-block-type="core.sticky"]').length, 'drawn blocks').toBe(1);
      expect(fixture.componentInstance['board']()?.blockIds().length, 'blocks').toBe(1);
    });

    it('when Save a copy is clicked then the importer saves the content and the new board opens', async () => {
      await render(linkTo());
      save.mockResolvedValue(aBoard({ id: 'copy-1', title: 'Shared plan' }));

      buttonByText(fixture, 'Save a copy').click();
      await fixture.whenStable();

      expect(save, 'importer calls').toHaveBeenCalledTimes(1);
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', 'copy-1']);
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.message),
        'toasts',
      ).toEqual(['A copy was saved as "Shared plan".']);
    });

    it('when saving fails then the user stays and can try again', async () => {
      await render(linkTo());
      save.mockResolvedValue(undefined);

      buttonByText(fixture, 'Save a copy').click();
      await fixture.whenStable();

      expect(navigate, 'navigation').not.toHaveBeenCalled();
      expect(buttonByText(fixture, 'Save a copy').disabled, 'button').toBe(false);
    });
  });

  describe('an invalid link', () => {
    it.each([
      ['no data', '', 'not a Drawboard board link'],
      ['a foreign prefix', 'v9.abc', 'not a Drawboard board link'],
      ['garbage data', 'v1.!!!', 'damaged'],
    ])(
      'when the link has %s then the reason is shown and nothing is drawn',
      async (_name, fragment, reason) => {
        await render(fragment);

        expect(all(fixture, '[data-testid=error]')[0]?.textContent, 'reason').toContain(reason);
        expect(all(fixture, 'drawboard-board-canvas').length, 'canvases').toBe(0);
      },
    );
  });
});
