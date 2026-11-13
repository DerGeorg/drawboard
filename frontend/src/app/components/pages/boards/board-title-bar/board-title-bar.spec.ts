import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Board, BoardRole } from '@apps/drawboard-api';

import { BoardDoc } from '../../../../../board-engine/model/board-doc';

import { all, buttonByLabel, buttonByText, textOf, typeInto } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, aBoard, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { provideTestRuntimeConfig } from '../../../../test/runtime-config';
import { BoardTemplates } from '../board-templates';
import { BoardTransfer } from '../board-transfer';
import { BoardTitleBar } from './board-title-bar';

describe('BoardTitleBar', () => {
  let fixture: ComponentFixture<BoardTitleBar>;
  const board = signal<Board | undefined>(undefined);
  const changed = vi.fn();
  const guest = signal(false);
  const docSignal = signal<BoardDoc | undefined>(undefined);
  const backLink = signal<string | null>('/boards');

  async function render(value: Board | null = aBoard()): Promise<void> {
    board.set(value ?? undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpTesting(),
        signedInAsAlice().providers,
        provideTestRuntimeConfig(),
      ],
    });
    fixture = TestBed.createComponent(BoardTitleBar, {
      bindings: [
        inputBinding('board', board),
        inputBinding('guest', guest),
        inputBinding('doc', docSignal),
        inputBinding('backLink', backLink),
        outputBinding('changed', changed),
      ],
    });
    await fixture.whenStable();
  }

  const el = (selector: string): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector(selector);

  beforeEach(() => {
    changed.mockClear();
    guest.set(false);
    docSignal.set(undefined);
    backLink.set('/boards');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('layout', () => {
    it('when the board is not loaded yet then only the back link is shown', async () => {
      await render(null);

      expect(el('[data-testid=back]')?.getAttribute('href'), 'back link').toBe('/boards');
      expect(el('[data-testid=title]'), 'title').toBeNull();
    });

    it('when the board is loaded then back link, title and role are shown', async () => {
      await render(aBoard({ role: BoardRole.OWNER }));

      expect(textOf(fixture), 'text').toContain('Sprint planning');
      expect(textOf(fixture), 'role').toContain('Owner');
    });

    it('when the user is only a viewer then the title is plain text', async () => {
      await render(aBoard({ role: BoardRole.VIEWER }));

      expect(el('h1[data-testid=title]')?.textContent?.trim(), 'plain title').toBe(
        'Sprint planning',
      );
      expect(el('button[data-testid=title]'), 'no rename button').toBeNull();
    });
  });

  describe('rename', () => {
    async function startRename(): Promise<void> {
      (el('button[data-testid=title]') as HTMLButtonElement).click();
      await fixture.whenStable();
    }

    it('when the title is clicked then an input with the title appears and has the focus', async () => {
      await render();

      await startRename();

      const input = el('#board-title-input') as HTMLInputElement;
      expect(input.value, 'value').toBe('Sprint planning');
      expect(document.activeElement, 'focus').toBe(input);
    });

    it('when a new title is submitted then the board is saved with its version and the page is told', async () => {
      await render(aBoard({ version: 3 }));
      await startRename();

      typeInto(fixture, '#board-title-input', 'Retro');
      (el('form') as HTMLFormElement).requestSubmit();
      await settle();
      const request = expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`, 'rename');
      request.flush(aBoard({ title: 'Retro', version: 4 }));
      await settle();
      await fixture.whenStable();

      expect(request.request.body, 'body with the loaded version').toEqual({
        title: 'Retro',
        version: 3,
      });
      expect(changed, 'page told to reload').toHaveBeenCalledTimes(1);
      expect(el('#board-title-input'), 'back to the title').toBeNull();
    });

    it('when Escape is pressed then nothing is saved', async () => {
      await render();
      await startRename();

      el('#board-title-input')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await fixture.whenStable();

      expect(el('#board-title-input'), 'input').toBeNull();
      expect(changed, 'no change').not.toHaveBeenCalled();
    });

    it('when the field is left unchanged then it just closes', async () => {
      await render();
      await startRename();

      el('#board-title-input')?.dispatchEvent(new Event('blur'));
      await fixture.whenStable();

      expect(el('#board-title-input'), 'input').toBeNull();
    });

    it('when the title is cleared and the field is left then it closes without a request', async () => {
      await render();
      await startRename();

      typeInto(fixture, '#board-title-input', '');
      await fixture.whenStable();

      expect(el('#board-title-input'), 'input').toBeNull();
      expect(changed, 'no change').not.toHaveBeenCalled();
    });

    it('when someone else changed the board first then the page reloads the current state', async () => {
      await render();
      await startRename();

      typeInto(fixture, '#board-title-input', 'Retro');
      (el('form') as HTMLFormElement).requestSubmit();
      await settle();
      expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`, 'rename').flush(
        aProblem({ code: 'LIBRARY_BOARD_VERSION_CONFLICT', status: 409 }),
        problemResponse(409, 'Conflict', 'req-409'),
      );
      await settle();
      await fixture.whenStable();

      expect(changed, 'page told to reload').toHaveBeenCalledTimes(1);
    });
  });

  describe('menu', () => {
    it('when the owner opens the menu then export, link, import, templates and version history are offered', async () => {
      await render();

      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      expect(
        all(fixture, '[role^=menuitem]').map((i) => i.textContent?.replace(/\s+/g, ' ').trim()),
        'entries',
      ).toEqual([
        'Export (.drawboard)',
        'Copy as link',
        'Import…',
        'Save as template',
        'Template Off',
        'Version history',
        'About Drawboard',
      ]);
    });

    it('when an editor opens the menu then version history is not offered', async () => {
      await render(aBoard({ role: BoardRole.EDITOR }));

      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      expect(
        all(fixture, '[role^=menuitem]').map((i) => i.textContent?.trim()),
        'entries',
      ).toEqual([
        'Export (.drawboard)',
        'Copy as link',
        'Import…',
        'Save as template',
        'About Drawboard',
      ]);
    });

    it('when About Drawboard is chosen then the About dialog opens and closes again', async () => {
      await render(aBoard({ role: BoardRole.EDITOR }));
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      buttonByText(fixture, 'About Drawboard').click();
      await fixture.whenStable();

      expect(el('[role=dialog]'), 'dialog').not.toBeNull();
      expect(el('[role=menu]'), 'menu closed behind it').toBeNull();
      expect(textOf(fixture), 'dialog text').toContain('Host your own Drawboard');

      buttonByLabel(fixture, 'Close').click();
      await fixture.whenStable();

      expect(el('[role=dialog]'), 'dialog closed').toBeNull();
    });

    it('when Version history is chosen then the dialog opens and closes again', async () => {
      await render();
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Version history').click();
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/versions`, 'versions').flush({
        items: [],
      });
      await settle();
      await fixture.whenStable();
      expect(all(fixture, 'drawboard-version-history').length, 'dialog').toBe(1);

      buttonByLabel(fixture, 'Close').click();
      await fixture.whenStable();
      expect(all(fixture, 'drawboard-version-history').length, 'dialog after close').toBe(0);
    });

    it('when Export is chosen then the document is exported with the board title', async () => {
      await render();
      const exportFile = vi.spyOn(TestBed.inject(BoardTransfer), 'exportFile').mockReturnValue();
      const doc = new BoardDoc();
      doc.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10 });
      docSignal.set(doc);
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Export (.drawboard)').click();
      await fixture.whenStable();

      expect(exportFile, 'export').toHaveBeenCalledWith(doc, 'Sprint planning');
      expect(all(fixture, '[role=menu]').length, 'menu closed').toBe(0);
    });

    it('when Copy as link is chosen then the link of the document is copied', async () => {
      await render();
      const copyLink = vi.spyOn(TestBed.inject(BoardTransfer), 'copyLink').mockResolvedValue();
      const doc = new BoardDoc();
      docSignal.set(doc);
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Copy as link').click();
      await fixture.whenStable();

      expect(copyLink, 'copy').toHaveBeenCalledWith(doc, 'Sprint planning');
    });

    it('when the document is not there yet then export and link do nothing', async () => {
      await render();
      const transfer = TestBed.inject(BoardTransfer);
      const exportFile = vi.spyOn(transfer, 'exportFile').mockReturnValue();
      const copyLink = vi.spyOn(transfer, 'copyLink').mockResolvedValue();
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Export (.drawboard)').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Copy as link').click();
      await fixture.whenStable();

      expect(exportFile, 'export').not.toHaveBeenCalled();
      expect(copyLink, 'copy').not.toHaveBeenCalled();
    });
  });

  describe('templates', () => {
    const switchItem = (): HTMLElement | null => el('[role=menuitemcheckbox]');

    async function openMenu(): Promise<void> {
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();
    }

    it('when the board is a template then a Template badge is shown and the switch is on', async () => {
      await render(aBoard({ template: true }));
      await openMenu();

      expect(el('[data-testid=template-badge]')?.textContent?.trim(), 'badge').toBe('Template');
      expect(switchItem()?.getAttribute('aria-checked'), 'switch state').toBe('true');
    });

    it('when the board is no template then there is no badge and the switch is off', async () => {
      await render();
      await openMenu();

      expect(el('[data-testid=template-badge]'), 'badge').toBeNull();
      expect(switchItem()?.getAttribute('aria-checked'), 'switch state').toBe('false');
    });

    it('when an editor opens the menu then the Template switch is not offered', async () => {
      await render(aBoard({ role: BoardRole.EDITOR }));
      await openMenu();

      expect(switchItem(), 'switch').toBeNull();
    });

    it('when a viewer opens the menu then the Template switch is not offered but Save as template is', async () => {
      await render(aBoard({ role: BoardRole.VIEWER }));
      await openMenu();

      expect(switchItem(), 'switch').toBeNull();
      expect(textOf(fixture), 'save as template').toContain('Save as template');
    });

    it('when the owner turns the switch on then the board is updated with its version and the page is told', async () => {
      await render(aBoard({ version: 4 }));
      await openMenu();

      (switchItem() as HTMLElement).click();
      await settle();
      const request = expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`, 'update board');
      expect(request.request.body, 'request body').toEqual({
        title: 'Sprint planning',
        template: true,
        version: 4,
      });
      request.flush(aBoard({ template: true, version: 5 }));
      await settle();

      expect(changed, 'page told').toHaveBeenCalledTimes(1);
    });

    it('when the owner turns the switch off then template false is sent', async () => {
      await render(aBoard({ template: true }));
      await openMenu();

      (switchItem() as HTMLElement).click();
      await settle();
      const request = expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`, 'update board');
      expect(request.request.body, 'request body').toEqual(
        expect.objectContaining({ template: false }),
      );
      request.flush(aBoard({ template: false }));
      await settle();
    });

    it('when the update is refused then the page reloads the current state anyway', async () => {
      await render();
      await openMenu();

      (switchItem() as HTMLElement).click();
      await settle();
      expectRequest('PUT', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({ code: 'INTERNAL_ERROR', status: 409 }),
        problemResponse(409, 'Conflict'),
      );
      await settle();

      expect(changed, 'page told').toHaveBeenCalledTimes(1);
    });

    const noFiles = (): void => {
      vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
        count: 0,
        bytes: 0,
      });
    };

    it('when Save as template is chosen then the board is copied from the open document', async () => {
      await render();
      const save = vi
        .spyOn(TestBed.inject(BoardTemplates), 'saveAsTemplate')
        .mockResolvedValue(aBoard({ template: true }));
      noFiles();
      const doc = new BoardDoc();
      docSignal.set(doc);
      await openMenu();

      buttonByText(fixture, 'Save as template').click();
      await settle();
      await fixture.whenStable();

      expect(save, 'save as template').toHaveBeenCalledWith(aBoard(), doc);
      expect(all(fixture, '[role=menu]').length, 'menu closed').toBe(0);
    });

    it('when the board has files then number and size are asked about before the copy', async () => {
      await render();
      const save = vi
        .spyOn(TestBed.inject(BoardTemplates), 'saveAsTemplate')
        .mockResolvedValue(aBoard({ template: true }));
      vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
        count: 2,
        bytes: 3_000_000,
      });
      await openMenu();

      buttonByText(fixture, 'Save as template').click();
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'question').toContain('2 files (3.0 MB together)');
      expect(save, 'not saved yet').not.toHaveBeenCalled();
    });

    it('when Copy without files is chosen then the template is saved without files', async () => {
      await render();
      const save = vi
        .spyOn(TestBed.inject(BoardTemplates), 'saveAsTemplate')
        .mockResolvedValue(aBoard({ template: true }));
      vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
        count: 2,
        bytes: 3_000_000,
      });
      await openMenu();
      buttonByText(fixture, 'Save as template').click();
      await settle();
      await fixture.whenStable();

      buttonByText(fixture, 'Copy without files').click();
      await settle();

      expect(save, 'save').toHaveBeenCalledWith(aBoard(), undefined, { files: false });
    });

    it('when the question is cancelled then nothing is saved', async () => {
      await render();
      const save = vi.spyOn(TestBed.inject(BoardTemplates), 'saveAsTemplate');
      vi.spyOn(TestBed.inject(BoardTemplates), 'fileSummary').mockResolvedValue({
        count: 1,
        bytes: 1_000,
      });
      await openMenu();
      buttonByText(fixture, 'Save as template').click();
      await settle();
      await fixture.whenStable();

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(save, 'save').not.toHaveBeenCalled();
      expect(all(fixture, 'drawboard-template-files-dialog').length, 'question').toBe(0);
    });
  });

  describe('import', () => {
    const fileInput = (): HTMLInputElement =>
      all<HTMLInputElement>(fixture, 'input[type=file]')[0] as HTMLInputElement;

    it('when Import is chosen then the file picker opens', async () => {
      await render();
      const click = vi.spyOn(fileInput(), 'click').mockReturnValue();
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Import…').click();
      await fixture.whenStable();

      expect(click, 'file picker').toHaveBeenCalled();
    });

    it('when a file is picked then it is imported and the menu says Importing… meanwhile', async () => {
      await render();
      let finish: () => void = () => undefined;
      const importFile = vi
        .spyOn(TestBed.inject(BoardTransfer), 'importFile')
        .mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
      const file = new File(['{}'], 'board.json');
      Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });

      fileInput().dispatchEvent(new Event('change'));
      await fixture.whenStable();
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'menu while importing').toContain('Importing…');

      finish();
      await settle();
      await fixture.whenStable();
      expect(importFile, 'import').toHaveBeenCalledWith(file);
      expect(textOf(fixture), 'menu after').not.toContain('Importing…');
    });

    it('when the picker is closed without a file then nothing is imported', async () => {
      await render();
      const importFile = vi.spyOn(TestBed.inject(BoardTransfer), 'importFile').mockResolvedValue();
      Object.defineProperty(fileInput(), 'files', { value: [], configurable: true });

      fileInput().dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(importFile, 'import').not.toHaveBeenCalled();
    });

    it('when the backdrop is clicked or Escape pressed then the menu closes', async () => {
      await render();
      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();

      (el('button.fixed') as HTMLButtonElement).click();
      await fixture.whenStable();
      expect(el('[role=menu]'), 'closed by the backdrop').toBeNull();

      buttonByLabel(fixture, 'More').click();
      await fixture.whenStable();
      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();
      expect(el('[role=menu]'), 'closed by Escape').toBeNull();
    });
  });

  describe('as a guest', () => {
    it('when a guest looks at a board then the title is plain text and there is no menu', async () => {
      guest.set(true);
      backLink.set(null);
      await render();

      expect(el('[data-testid=back]'), 'back link').toBeNull();
      expect(el('button[title="Click to rename"]'), 'rename button').toBeNull();
      expect(el('button[aria-label=More]'), 'menu button').toBeNull();
      expect(textOf(fixture), 'title').toContain('Sprint planning');
    });

    it('when a guest came from a folder then the arrow leads back to the folder', async () => {
      guest.set(true);
      backLink.set('/s/f/folder-1');
      await render();

      expect(el('[data-testid=back]')?.getAttribute('href'), 'back link').toBe('/s/f/folder-1');
      expect(el('[data-testid=back]')?.getAttribute('aria-label'), 'label').toBe(
        'Back to the folder',
      );
    });
  });
});
