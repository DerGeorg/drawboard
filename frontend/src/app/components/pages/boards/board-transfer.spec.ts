import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { strToU8, zipSync } from 'fflate';

import { ARCHIVE_LIMITS, exportArchive } from '../../../../board-engine/io/archive';
import { BoardDoc } from '../../../../board-engine/model/board-doc';
import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { aBoard } from '../../../test/fixtures';
import { provideHttpTesting } from '../../../test/http-testing';
import { BoardImporter } from './board-importer';
import { BoardTransfer } from './board-transfer';

const validJson = JSON.stringify({
  schemaVersion: 1,
  title: 'From a file',
  blocks: [{ id: 'b1', type: 'core.sticky', x: 0, y: 0, w: 10, h: 10, text: 'hi' }],
});

describe('BoardTransfer', () => {
  let transfer: BoardTransfer;
  let toasts: Toasts;
  let save: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.spyOn>;

  const messages = (): string[] => toasts.toasts().map((t) => t.message);

  beforeEach(() => {
    save = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpTesting(),
        signedInAsAlice().providers,
        { provide: BoardImporter, useValue: { save } },
      ],
    });
    transfer = TestBed.inject(BoardTransfer);
    toasts = TestBed.inject(Toasts);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  describe('exportFile', () => {
    it('when a board is exported then a .drawboard download with a safe name starts', async () => {
      const board = new BoardDoc();
      board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10, text: 'x' });
      let blob: Blob | undefined;
      URL.createObjectURL = vi.fn((b: Blob) => {
        blob = b;
        return 'blob:test';
      });
      URL.revokeObjectURL = vi.fn();
      const clicked: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this.download);
      });

      transfer.exportFile(board, 'Plan: Q4/2026 <draft>');

      expect(clicked, 'download names').toEqual(['Plan_ Q4_2026 _draft_.drawboard']);
      expect(blob?.type, 'type').toBe('application/zip');
      expect(blob?.size, 'size').toBeGreaterThan(100);
    });

    it('when the title is empty then the file is called board.drawboard', () => {
      URL.createObjectURL = vi.fn(() => 'blob:test');
      URL.revokeObjectURL = vi.fn();
      const clicked: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this.download);
      });

      transfer.exportFile(new BoardDoc(), '');

      expect(clicked, 'download names').toEqual(['board.drawboard']);
    });
  });

  describe('copyLink', () => {
    it('when the clipboard works then the /open link with a v1 fragment is copied and a toast tells', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const board = new BoardDoc();
      board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10, text: 'x' });

      await transfer.copyLink(board, 'Plan');

      const url = writeText.mock.calls[0]?.[0] as string;
      expect(url.startsWith(`${window.location.origin}/open#v1.`), 'link').toBe(true);
      expect(messages()[0], 'toast').toContain('Link copied');
    });

    it('when the clipboard is refused then an error toast says so', async () => {
      vi.stubGlobal('navigator', {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
      });

      await transfer.copyLink(new BoardDoc(), 'Plan');

      expect(messages(), 'toasts').toEqual(['The link could not be copied.']);
    });

    it('when the board is too large for a link then the toast suggests the export', async () => {
      vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
      const board = new BoardDoc();
      const random = Array.from({ length: 1_500_000 }, () =>
        String.fromCharCode(33 + Math.floor(Math.random() * 90)),
      ).join('');
      for (let i = 0; i < 15; i++) {
        board.addBlock({
          type: 'core.text',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          text: random.slice(i * 100_000, (i + 1) * 100_000),
        });
      }

      await transfer.copyLink(board, 'Big');

      expect(messages()[0], 'toast').toContain('Export it as a file');
    });
  });

  describe('readFile', () => {
    const fileOf = (bytes: Uint8Array | string, name = 'x'): File =>
      new File([typeof bytes === 'string' ? bytes : (bytes as Uint8Array<ArrayBuffer>)], name);

    it('when the file is a .drawboard archive then its board.json is read', async () => {
      const board = new BoardDoc();
      board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10, text: 'zip' });

      const file = await transfer.readFile(fileOf(exportArchive(board, 'Zipped'), 'a.drawboard'));

      expect(file.title, 'title').toBe('Zipped');
      expect(file.blocks[0]?.text, 'text').toBe('zip');
    });

    it('when the file is a plain board.json then it is read as JSON', async () => {
      const file = await transfer.readFile(fileOf(validJson, 'board.json'));

      expect(file.blocks.length, 'blocks').toBe(1);
    });

    it('when the file is bigger than the ZIP limit then it is refused without reading it', async () => {
      const big = { size: ARCHIVE_LIMITS.maxZipBytes + 1 } as File;

      await expect(transfer.readFile(big), 'rejection').rejects.toThrow('200 MB');
    });

    it('when a JSON file is bigger than 20 MB then it is refused', async () => {
      const big = fileOf(' '.repeat(ARCHIVE_LIMITS.maxBoardJsonBytes + 1));

      await expect(transfer.readFile(big), 'rejection').rejects.toThrow('20 MB');
    });
  });

  describe('importFile', () => {
    it('when the file is valid then the importer saves it and the new board opens', async () => {
      save.mockResolvedValue(aBoard({ id: 'new-1', title: 'From a file' }));

      await transfer.importFile(new File([validJson], 'board.json'));

      expect(save, 'importer calls').toHaveBeenCalledTimes(1);
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/boards', 'new-1']);
      expect(messages(), 'toasts').toEqual(['"From a file" was imported.']);
    });

    it('when the importer fails then nothing opens and no success toast appears', async () => {
      save.mockResolvedValue(undefined);

      await transfer.importFile(new File([validJson], 'board.json'));

      expect(navigate, 'navigation').not.toHaveBeenCalled();
      expect(messages(), 'toasts').toEqual([]);
    });

    it('when the file is invalid then the reason is toasted and the importer is not called', async () => {
      await transfer.importFile(
        new File([zipSync({ other: strToU8('x') }) as Uint8Array<ArrayBuffer>], 'a.drawboard'),
      );

      expect(messages(), 'toasts').toEqual(['This archive has no board.json.']);
      expect(save, 'importer calls').not.toHaveBeenCalled();
    });

    it('when the file is not even a board then a generic message is not needed: the JSON error is shown', async () => {
      await transfer.importFile(new File(['not json'], 'x.json'));

      expect(messages(), 'toasts').toEqual(['The file is not valid JSON.']);
    });
  });
});
