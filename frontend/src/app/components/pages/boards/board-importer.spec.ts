import { HttpTestingController } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { BoardFile, parseBoardFile, BoardDoc } from '@apps/drawboard-engine';
import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { aBoard, aProblem } from '../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../test/http-testing';
import { BoardCollab } from './board-collab';
import { BoardImporter, DEFAULT_IMPORT_TITLE, IMPORT_PIECE_BYTES } from './board-importer';

/** The writer's connection without a socket: records what happens. */
class FakeWriter {
  static instance: FakeWriter | undefined;
  readonly doc = signal(new BoardDoc());
  readonly connected: string[] = [];
  readonly flushes: number[] = [];
  syncFails = false;
  readonly state = signal<{ reloadRequired: boolean } | undefined>(undefined);
  /** Set by a test: the provider dropped a piece as too large while it was flushed. */
  dropsPiece = false;

  constructor() {
    FakeWriter.instance = this;
  }

  connect(boardId: string): void {
    this.connected.push(boardId);
  }

  whenSynced(): Promise<void> {
    return this.syncFails ? Promise.reject(new Error('denied')) : Promise.resolve();
  }

  whenFlushed(): Promise<void> {
    this.flushes.push(this.doc().blockIds().length);
    if (this.dropsPiece) {
      this.state.set({ reloadRequired: true });
    }
    return Promise.resolve();
  }
}

function aFile(blocks = 1, extra: Partial<BoardFile> = {}): BoardFile {
  return {
    ...parseBoardFile({
      schemaVersion: 1,
      title: 'From a file',
      blocks: Array.from({ length: blocks }, (_, i) => ({
        id: `b${i}`,
        type: 'core.sticky',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        text: 'x'.repeat(50_000),
      })),
    }),
    ...extra,
  };
}

describe('BoardImporter', () => {
  let importer: BoardImporter;

  beforeEach(() => {
    FakeWriter.instance = undefined;
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    importer = TestBed.inject(BoardImporter);
    importer.collabType = FakeWriter as unknown as typeof BoardCollab;
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('save', () => {
    it('when the file is valid then a board with the file title is created and the content is written to it', async () => {
      const result = importer.save(aFile(2));
      await settle();
      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'body').toEqual({ title: 'From a file' });
      create.flush(aBoard({ id: 'new-board' }), { status: 201, statusText: 'Created' });

      const board = await result;

      expect(board?.id, 'board').toBe('new-board');
      expect(FakeWriter.instance?.connected, 'connected to the new board').toEqual(['new-board']);
      expect(FakeWriter.instance?.doc().blockIds().sort(), 'content').toEqual(['b0', 'b1']);
    });

    it('when the content is big then it is written in pieces, each flushed before the next', async () => {
      const result = importer.save(aFile(12));
      await settle();
      expectRequest('POST', '/api/boards').flush(aBoard(), { status: 201, statusText: 'Created' });
      await result;

      const flushes = FakeWriter.instance?.flushes ?? [];
      expect(flushes.length, 'pieces').toBeGreaterThan(2);
      expect(flushes[flushes.length - 1], 'all blocks at the end').toBe(12);
      expect(IMPORT_PIECE_BYTES, 'piece size stays below the 1 MiB frame limit').toBeLessThan(
        1024 * 1024,
      );
    });

    it.each([
      ['the file has no title', '', undefined, DEFAULT_IMPORT_TITLE],
      ['a title is given', 'From a file', 'Chosen title', 'Chosen title'],
    ])('when %s then the right title is used', async (_name, fileTitle, given, expected) => {
      const result = importer.save(aFile(1, { title: fileTitle }), given);
      await settle();
      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'body').toEqual({ title: expected });
      create.flush(aBoard(), { status: 201, statusText: 'Created' });

      await result;
    });

    it('when options are given then folder and template flag go to createBoard', async () => {
      const result = importer.save(aFile(), undefined, { folderId: 'folder-1', template: true });
      await settle();

      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'body').toEqual({
        title: 'From a file',
        folderId: 'folder-1',
        template: true,
      });
      create.flush(aBoard(), { status: 201, statusText: 'Created' });

      await result;
    });

    it('when prepare changes the file then the changed content is written, after the board exists', async () => {
      const seen: string[] = [];
      const result = importer.save(aFile(2), undefined, {
        prepare: (board, file) => {
          seen.push(board.id);
          return Promise.resolve({ ...file, blocks: file.blocks.slice(0, 1) });
        },
      });
      await settle();
      expectRequest('POST', '/api/boards').flush(aBoard({ id: 'new-board' }), {
        status: 201,
        statusText: 'Created',
      });

      await result;

      expect(seen, 'prepare saw the new board').toEqual(['new-board']);
      expect(FakeWriter.instance?.doc().blockIds(), 'written content').toEqual(['b0']);
    });

    it('when prepare fails then the empty board is deleted again, a toast tells and nothing is connected', async () => {
      const result = importer.save(aFile(), undefined, {
        prepare: () => Promise.reject(new Error('boom')),
      });
      await settle();
      expectRequest('POST', '/api/boards').flush(aBoard({ id: 'half' }), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      expectRequest('DELETE', '/api/boards/half', 'discard').flush(null, {
        status: 204,
        statusText: 'No Content',
      });

      expect(await result, 'result').toBeUndefined();
      expect(FakeWriter.instance, 'writer created').toBeUndefined();
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.kind),
        'toast kinds',
      ).toEqual(['error']);
    });

    it('when createBoard fails then undefined is returned and nothing is connected', async () => {
      const result = importer.save(aFile());
      await settle();
      expectRequest('POST', '/api/boards').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );

      expect(await result, 'result').toBeUndefined();
      expect(FakeWriter.instance, 'writer created').toBeUndefined();
    });

    it('when the provider drops a piece as too large then the import fails and the board is deleted', async () => {
      importer.collabType = class extends FakeWriter {
        override dropsPiece = true;
      } as unknown as typeof BoardCollab;
      const result = importer.save(aFile());
      await settle();
      expectRequest('POST', '/api/boards').flush(aBoard({ id: 'lost' }), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      expectRequest('DELETE', '/api/boards/lost', 'discard').flush(null, {
        status: 204,
        statusText: 'No Content',
      });

      expect(await result, 'no success without the content').toBeUndefined();
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.kind),
        'toast kinds',
      ).toEqual(['error']);
    });

    it('when the connection cannot be synced then the empty board is deleted again and a toast tells', async () => {
      importer.collabType = class extends FakeWriter {
        override syncFails = true;
      } as unknown as typeof BoardCollab;
      const result = importer.save(aFile());
      await settle();
      expectRequest('POST', '/api/boards').flush(aBoard({ id: 'half' }), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      expectRequest('DELETE', '/api/boards/half', 'discard').flush(null, {
        status: 204,
        statusText: 'No Content',
      });

      expect(await result, 'result').toBeUndefined();
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.kind),
        'toast kinds',
      ).toEqual(['error']);
    });
  });
});
