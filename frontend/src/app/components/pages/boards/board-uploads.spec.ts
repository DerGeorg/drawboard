import { HttpEventType } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BoardFile, BoardFileConversion, BoardFileKind } from '@apps/drawboard-api';

import { FILE_TYPE } from '../../../../board-engine/blocks/file';
import { BoardEngine } from '../../../../board-engine/engine';
import { BoardDoc } from '../../../../board-engine/model/board-doc';
import { signedInAsAlice } from '../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../test/http-testing';
import { BoardFiles } from './board-files';
import { BoardUploads, MAX_FILE_BYTES, check } from './board-uploads';

const FILE_ID = '0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f';
const UPLOAD = `/api/boards/${SPRINT_BOARD_ID}/files`;

function stored(overrides: Partial<BoardFile> = {}): BoardFile {
  return {
    id: FILE_ID,
    boardId: SPRINT_BOARD_ID,
    name: 'photo.png',
    mediaType: 'image/png',
    kind: BoardFileKind.IMAGE,
    size: 4,
    createdAt: '2026-11-10T10:00:00Z',
    conversion: BoardFileConversion.NONE,
    width: 960,
    height: 480,
    ...overrides,
  };
}

const aFile = (name: string, size = 4, type = ''): File => {
  const file = new File(['data'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

describe('BoardUploads', () => {
  let uploads: BoardUploads;
  let engine: BoardEngine;
  let board: BoardDoc;
  let container: HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers, BoardFiles, BoardUploads],
    });
    uploads = TestBed.inject(BoardUploads);
    TestBed.inject(BoardFiles).open(SPRINT_BOARD_ID);
    uploads.open(SPRINT_BOARD_ID);
    container = document.createElement('div');
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    uploads.bind(engine);
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    engine.destroy();
    board.destroy();
  });

  describe('upload', () => {
    it('when a file is uploaded then progress shows and a file block appears where it was dropped', async () => {
      uploads.upload([aFile('photo.png')], { x: 500, y: 300 });
      await settle();

      const req = expectRequest('POST', UPLOAD, 'upload');
      expect(req.request.body instanceof FormData, 'multipart').toBe(true);
      expect((req.request.body as FormData).get('file'), 'the file part').toBeInstanceOf(File);
      req.event({ type: HttpEventType.UploadProgress, loaded: 2, total: 4 });
      expect(uploads.items()[0]?.progress, 'half').toBe(0.5);
      req.flush(stored(), { status: 201, statusText: 'Created' });

      const block = board.blocks()[0];
      expect(uploads.items()[0]?.status, 'done').toBe('done');
      expect(block?.type, 'file block').toBe(FILE_TYPE);
      expect(block?.props, 'only the id').toEqual({ fileId: FILE_ID });
      expect(block && block.x + block.w / 2, 'centred on the drop').toBe(500);
      expect(block?.w, 'image width scaled to 480').toBe(480);
    });

    it('when several files are dropped then they go one after the other', async () => {
      uploads.upload([aFile('a.png'), aFile('b.pdf')]);
      await settle();

      expectRequest('POST', UPLOAD, 'first').flush(stored(), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      expect(uploads.items()[1]?.status, 'second running').toBe('uploading');
      expectRequest('POST', UPLOAD, 'second').flush(
        stored({ id: '0192f5e0-7c1a-7b3e-8f00-000000000002', kind: BoardFileKind.PDF }),
        { status: 201, statusText: 'Created' },
      );

      expect(board.blocks().length, 'two blocks').toBe(2);
    });

    it('when the server refuses the file then the reason and request id stay in the list', async () => {
      uploads.upload([aFile('movie.png')]);
      await settle();

      expectRequest('POST', UPLOAD, 'upload').flush(
        { code: 'FILES_TYPE_NOT_ALLOWED', status: 415, title: 'Unsupported', requestId: 'req-1' },
        { status: 415, statusText: 'Unsupported Media Type' },
      );

      const item = uploads.items()[0];
      expect(item?.status, 'failed').toBe('failed');
      expect(item?.error, 'reason').toContain('This file type is not allowed');
      expect(item?.requestId, 'request id').toBe('req-1');
      expect(board.blocks().length, 'no block').toBe(0);
    });

    it('when a file breaks a limit then it is never sent', async () => {
      uploads.upload([
        aFile('drawing.svg', 4, 'image/svg+xml'),
        aFile('big.pdf', MAX_FILE_BYTES + 1),
      ]);
      await settle();

      TestBed.inject(HttpTestingController).expectNone(UPLOAD, 'nothing sent');
      expect(
        uploads.items().map((i) => i.error),
        'reasons',
      ).toEqual(['SVG images are not allowed.', 'The file is larger than 50 MB.']);
    });

    it('when more than 30 files are dropped then the rest is refused', async () => {
      const many = Array.from({ length: 31 }, (_, i) => aFile(`f${i}.png`));

      uploads.upload(many);
      await settle();

      expect(uploads.items()[30]?.error, 'the 31st').toBe('At most 30 files at once.');
      for (let i = 0; i < 30; i++) {
        expectRequest('POST', UPLOAD, `upload ${i}`).flush(stored(), {
          status: 201,
          statusText: 'Created',
        });
        await settle();
      }
      uploads.clearFinished();
      expect(uploads.items().length, 'finished and failed removed').toBe(0);
    });
  });

  describe('check', () => {
    it.each([
      ['photo.JPG', 1000, undefined],
      ['clip.mp4', MAX_FILE_BYTES + 1, undefined],
      ['clip.webm', 500 * 1_000_000 + 1, 'The file is larger than 500 MB.'],
      ['notes.txt', 10, 'This file type is not supported.'],
      ['README', 10, 'This file type is not supported.'],
      ['empty.png', 0, 'The file is empty.'],
      ['slides.pptx', 10, undefined],
    ])('when %s with %d bytes is checked then the answer is %s', (name, size, expected) => {
      expect(check(aFile(name, size)), name).toBe(expected);
    });
  });
});
