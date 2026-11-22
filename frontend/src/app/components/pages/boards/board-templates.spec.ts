import { HttpTestingController } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BoardFile as StoredFile, BoardFileConversion, BoardFileKind } from '@apps/drawboard-api';

import {
  BoardFile,
  parseBoardFile,
  writeBoardFile,
  BoardDoc,
  loadBuiltinTemplates,
} from '@apps/drawboard-engine';
import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { RETRO_BOARD_ID, SPRINT_BOARD_ID, aBoard } from '../../../test/fixtures';
import { expectRequest, provideHttpTesting, settle } from '../../../test/http-testing';
import { BoardCollab } from './board-collab';
import { BoardImporter } from './board-importer';
import { MAX_FILE_BYTES } from './board-uploads';
import { BoardTemplates, MAX_RATE_LIMIT_RETRIES } from './board-templates';

const OLD_A = '0192f5e0-7c1a-7b3e-8f00-00000000000a';
const OLD_B = '0192f5e0-7c1a-7b3e-8f00-00000000000b';
const NEW_A = '0192f5e0-7c1a-7b3e-8f00-0000000000aa';
const NEW_B = '0192f5e0-7c1a-7b3e-8f00-0000000000bb';
const SOURCE = '0192f5e0-0000-7000-8000-00000000cafe';
const TARGET = '0192f5e0-0000-7000-8000-00000000beef';

/** A connection without a socket: writers record what is written, readers hold a document. */
class FakeConnection {
  static readers: FakeConnection[] = [];
  /** Runs when a reader is asked to load: a test can end its session at a chosen moment. */
  static writers: FakeConnection[] = [];
  static content: BoardDoc | undefined;
  static loadFails = false;

  readonly doc = signal(new BoardDoc());
  readonly state = signal<{ status: string } | undefined>({ status: 'synced' });
  readonly connected: string[] = [];

  connect(boardId: string): void {
    this.connected.push(boardId);
  }

  /** What the server does to a reader during the copy: ends its session. */
  static endSession(): void {
    for (const reader of FakeConnection.readers) {
      reader.state.set({ status: 'denied' });
    }
  }

  whenLoaded(): Promise<void> {
    if (FakeConnection.loadFails) {
      return Promise.reject(new Error('denied'));
    }
    if (FakeConnection.content) {
      this.doc.set(FakeConnection.content);
    }
    return Promise.resolve();
  }

  whenSynced(): Promise<void> {
    return Promise.resolve();
  }

  whenFlushed(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeReader extends FakeConnection {
  constructor() {
    super();
    FakeConnection.readers.push(this);
  }
}

class FakeWriter extends FakeConnection {
  constructor() {
    super();
    FakeConnection.writers.push(this);
  }
}

function templateDoc(fileIds: string[]): BoardDoc {
  const file: BoardFile = parseBoardFile({
    schemaVersion: 1,
    title: 'ignored',
    blocks: [
      { id: 's1', type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, text: 'Hello' },
      ...fileIds.map((id, i) => ({
        id: `f${i}`,
        type: 'core.file',
        x: 200 + i * 120,
        y: 0,
        w: 100,
        h: 100,
        props: { fileId: id },
      })),
    ],
  });
  const doc = new BoardDoc();
  writeBoardFile(doc, file);
  return doc;
}

function stored(id: string, name: string): StoredFile {
  return {
    id,
    boardId: TARGET,
    name,
    mediaType: 'image/png',
    kind: BoardFileKind.IMAGE,
    size: 4,
    createdAt: '2026-11-10T10:00:00Z',
    conversion: BoardFileConversion.NONE,
  };
}

const meta = (id: string, name: string): StoredFile => ({ ...stored(id, name), boardId: SOURCE });

function signedUrl(id: string): Record<string, string> {
  const path = `/files/${id}?v=original&exp=1&sig=s`;
  return {
    fileId: id,
    url: path,
    originalUrl: path,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe('BoardTemplates', () => {
  let templates: BoardTemplates;
  let toasts: Toasts;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  /** The copy asks which plugins are enabled before it creates anything. */
  async function answerPlugins(items: unknown[] = []): Promise<void> {
    expectRequest('GET', '/api/plugins', 'enabled plugins').flush({ items });
    await settle();
  }

  const written = (): string[] => FakeConnection.writers[0]?.doc().blockIds().sort() ?? [];
  const writtenFileIds = (): unknown[] =>
    FakeConnection.writers[0]
      ?.doc()
      .blocks()
      .filter((b) => b.type === 'core.file')
      .map((b) => b.props['fileId'])
      .sort() ?? [];

  beforeEach(() => {
    FakeConnection.readers = [];
    FakeConnection.writers = [];
    FakeConnection.content = undefined;
    FakeConnection.loadFails = false;
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    templates = TestBed.inject(BoardTemplates);
    templates.collabType = FakeReader as unknown as typeof BoardCollab;
    TestBed.inject(BoardImporter).collabType = FakeWriter as unknown as typeof BoardCollab;
    toasts = TestBed.inject(Toasts);
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('data')));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    TestBed.inject(HttpTestingController).verify();
  });

  describe('from a built-in template', () => {
    it('when a built-in template is used then a board with its title and content is created in the folder', async () => {
      const template = (await loadBuiltinTemplates())[0];
      const result = templates.fromBuiltin(template, { folderId: 'folder-1' });
      await settle();

      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'request body').toEqual({
        title: template.title,
        folderId: 'folder-1',
      });
      create.flush(aBoard({ id: TARGET }), { status: 201, statusText: 'Created' });
      const board = await result;

      expect(board?.id, 'new board').toBe(TARGET);
      expect(written(), 'content').toEqual(template.file.blocks.map((b) => b.id).sort());
      expect(FakeConnection.readers.length, 'no reader needed').toBe(0);
    });

    it('when a title is given then it replaces the template title and the template stays unchanged', async () => {
      const template = (await loadBuiltinTemplates())[1];
      const before = JSON.stringify(template.file);
      const result = templates.fromBuiltin(template, { title: 'Our retro' });
      await settle();

      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'request body').toEqual({ title: 'Our retro' });
      create.flush(aBoard(), { status: 201, statusText: 'Created' });
      await result;

      expect(JSON.stringify(template.file), 'template untouched').toBe(before);
    });
  });

  describe('from a template board without files', () => {
    it('when a template board is used then its document is read and written into a new board', async () => {
      FakeConnection.content = templateDoc([]);
      const source = aBoard({ id: SOURCE, title: 'Team retro', template: true });

      const result = templates.fromBoard(source);
      await settle();
      await answerPlugins();
      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'request body').toEqual({ title: 'Team retro' });
      create.flush(aBoard({ id: TARGET, title: 'Team retro' }), {
        status: 201,
        statusText: 'Created',
      });
      const board = await result;

      expect(FakeConnection.readers[0]?.connected, 'reader connected to the template').toEqual([
        SOURCE,
      ]);
      expect(board?.id, 'new board').toBe(TARGET);
      expect(written(), 'content').toEqual(['s1']);
      expect(toasts.toasts(), 'no toast').toEqual([]);
    });

    it('when a title and a folder are given then both go to createBoard', async () => {
      FakeConnection.content = templateDoc([]);

      const result = templates.fromBoard(aBoard({ id: SOURCE, template: true }), {
        title: 'Mine',
        folderId: 'f9',
      });
      await settle();
      await answerPlugins();
      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'request body').toEqual({ title: 'Mine', folderId: 'f9' });
      create.flush(aBoard({ id: TARGET }), { status: 201, statusText: 'Created' });
      await result;
    });

    it('when the template cannot be read then a toast tells and no board is created', async () => {
      FakeConnection.loadFails = true;

      const board = await templates.fromBoard(aBoard({ id: SOURCE, template: true }));

      expect(board, 'result').toBeUndefined();
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['The template could not be read.']);
    });
  });

  describe('files', () => {
    async function copy(ids: string[]): Promise<{ board: Promise<unknown> }> {
      FakeConnection.content = templateDoc(ids);
      const board = templates.fromBoard(
        aBoard({ id: SOURCE, title: 'With files', template: true }),
      );
      await settle();
      await answerPlugins();
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      return { board };
    }

    async function answerLookup(ids: string[]): Promise<void> {
      expectRequest('GET', `/api/boards/${SOURCE}/files`, 'list files of the template').flush({
        items: ids.map((id) => meta(id, `${id.slice(-1)}.png`)),
      });
      await settle();
      expectRequest('GET', `/api/boards/${SOURCE}/files/urls`, 'signed urls').flush({
        items: ids.map(signedUrl),
      });
      await settle();
      expect(ids.length, 'asked for files').toBeGreaterThan(0);
    }

    const upload = () =>
      TestBed.inject(HttpTestingController).expectOne(
        (r) => r.method === 'POST' && r.url === `/api/boards/${TARGET}/files`,
        'upload to the new board',
      );

    it('when the template has files then each is downloaded by its signed URL and uploaded to the new board', async () => {
      const { board } = await copy([OLD_A, OLD_B]);

      await answerLookup([OLD_A, OLD_B]);
      upload().flush(stored(NEW_A, 'a.png'));
      await settle();
      upload().flush(stored(NEW_B, 'b.png'));
      const result = await board;

      expect((result as { id: string }).id, 'new board').toBe(TARGET);
      expect(
        fetchSpy.mock.calls.map((c: unknown[]) => c[0]),
        'downloaded',
      ).toEqual([
        `/files/${OLD_A}?v=original&exp=1&sig=s`,
        `/files/${OLD_B}?v=original&exp=1&sig=s`,
      ]);
      expect(fetchSpy.mock.calls[0]?.[1], 'no cookies, no referrer, no redirects').toEqual({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
      expect(writtenFileIds(), 'blocks point at the copies').toEqual([NEW_A, NEW_B]);
      expect(toasts.toasts(), 'no toast').toEqual([]);
    });

    it('when the upload is made then it carries the file name and type of the original', async () => {
      const { board } = await copy([OLD_A]);

      await answerLookup([OLD_A]);
      const request = upload();
      const sent = (request.request.body as FormData).get('file') as File;
      request.flush(stored(NEW_A, 'a.png'));
      await board;

      expect(sent.name, 'name').toBe('a.png');
      expect(sent.type, 'type').toBe('image/png');
    });

    it('when two blocks show the same file then it is copied once and both blocks follow', async () => {
      const { board } = await copy([OLD_A, OLD_A]);

      await answerLookup([OLD_A]);
      upload().flush(stored(NEW_A, 'a.png'));
      await board;

      expect(writtenFileIds(), 'both blocks').toEqual([NEW_A, NEW_A]);
    });

    it('when one upload fails then its block keeps the old id and one toast says how many are missing', async () => {
      const { board } = await copy([OLD_A, OLD_B]);

      await answerLookup([OLD_A, OLD_B]);
      upload().flush(stored(NEW_A, 'a.png'));
      await settle();
      upload().flush(
        { code: 'FILES_QUOTA_EXCEEDED', status: 413 },
        { status: 413, statusText: 'Payload Too Large' },
      );
      const result = await board;

      expect(result, 'the board was still created').toBeDefined();
      expect(writtenFileIds(), 'one copied, one kept').toEqual([NEW_A, OLD_B].sort());
      expect(
        toasts.toasts().map((t) => [t.kind, t.message]),
        'toasts',
      ).toEqual([['error', '1 of 2 files could not be copied. Its block shows “not available”.']]);
    });

    it('when the download fails then no upload happens and the block keeps the old id', async () => {
      fetchSpy.mockImplementation(() => Promise.resolve(new Response('no', { status: 403 })));
      const { board } = await copy([OLD_A]);

      await answerLookup([OLD_A]);
      await board;

      expect(writtenFileIds(), 'old id kept').toEqual([OLD_A]);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['1 of 1 file could not be copied. Its block shows “not available”.']);
    });

    it('when the template board does not know a file then it counts as missing without a download', async () => {
      const { board } = await copy([OLD_A, OLD_B]);

      expectRequest('GET', `/api/boards/${SOURCE}/files`, 'list files of the template').flush({
        items: [meta(OLD_A, 'a.png')],
      });
      await settle();
      expectRequest('GET', `/api/boards/${SOURCE}/files/${OLD_B}`, 'get the unknown file').flush(
        { code: 'FILES_FILE_NOT_FOUND', status: 404 },
        { status: 404, statusText: 'Not Found' },
      );
      await settle();
      expectRequest('GET', `/api/boards/${SOURCE}/files/urls`, 'signed urls').flush({
        items: [signedUrl(OLD_A)],
      });
      await settle();
      upload().flush(stored(NEW_A, 'a.png'));
      await board;

      expect(fetchSpy.mock.calls.length, 'only the known file was downloaded').toBe(1);
      expect(writtenFileIds(), 'one copied, one kept').toEqual([NEW_A, OLD_B].sort());
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['1 of 2 files could not be copied. Its block shows “not available”.']);
    });
  });

  describe('save as template', () => {
    it('when the open document is given then a template copy is created without a second connection', async () => {
      const doc = templateDoc([]);
      const board = aBoard({ id: SPRINT_BOARD_ID, title: 'Sprint 12' });

      const result = templates.saveAsTemplate(board, doc);
      await settle();
      await answerPlugins();
      const create = expectRequest('POST', '/api/boards', 'create board');
      expect(create.request.body, 'request body').toEqual({ title: 'Sprint 12', template: true });
      create.flush(aBoard({ id: RETRO_BOARD_ID, title: 'Sprint 12', template: true }), {
        status: 201,
        statusText: 'Created',
      });
      const copy = await result;

      expect(copy?.template, 'a template').toBe(true);
      expect(FakeConnection.readers.length, 'no reader').toBe(0);
      expect(written(), 'content').toEqual(['s1']);
      expect(
        toasts.toasts().map((t) => [t.kind, t.message]),
        'toast',
      ).toEqual([['success', 'Saved as the template “Sprint 12”. Find it under Templates.']]);
    });

    it('when no document is given then the board is read over a connection of its own', async () => {
      FakeConnection.content = templateDoc([]);

      const result = templates.saveAsTemplate(aBoard({ id: SOURCE }));
      await settle();
      await answerPlugins();
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await result;

      expect(FakeConnection.readers[0]?.connected, 'reader').toEqual([SOURCE]);
    });

    it('when the board cannot be read then no template is created and no success toast shows', async () => {
      FakeConnection.loadFails = true;

      const copy = await templates.saveAsTemplate(aBoard({ id: SOURCE }));

      expect(copy, 'result').toBeUndefined();
      expect(
        toasts.toasts().map((t) => t.kind),
        'toast kinds',
      ).toEqual(['error']);
    });
  });

  describe('validation as an import', () => {
    const PLUGIN = {
      id: 'org.example.timer',
      version: '1.0.0',
      assetBase: '/a/',
      entry: 'index.js',
      integrity: 'sha384-x',
      blockTypes: [
        { type: 'org.example.timer.clock', label: 'Clock', defaultWidth: 10, defaultHeight: 10 },
      ],
      grantedCapabilities: [],
      userPseudonym: 'p'.repeat(43),
    };

    /** A document as a stranger could have made it: bad props, a disabled plugin, a poker round id. */
    function untrustedDoc(): { doc: BoardDoc; good: string } {
      const doc = new BoardDoc();
      const good = doc.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, text: 'ok' });
      const bad = doc.addBlock({ type: 'core.sticky', x: 120, y: 0, w: 100, h: 100 });
      doc.setProp(bad, 'color', 'url(https://evil.test/x)');
      const disabled = doc.addBlock({
        type: 'org.example.timer.clock',
        x: 240,
        y: 0,
        w: 100,
        h: 100,
        props: { secret: 'plugin data' },
      });
      doc.addConnector({ block: good, anchor: 'auto' }, { block: disabled, anchor: 'auto' });
      doc.addConnector({ block: good, anchor: 'auto' }, { x: 5, y: 5 });
      const story = doc.addBlock({ type: 'core.story', x: 400, y: 0, w: 300, h: 220 });
      doc.setProp(story, 'pokerRoundId', 'round-secret');
      return { doc, good };
    }

    async function copyUntrusted(enabled: unknown[]): Promise<void> {
      FakeConnection.content = untrustedDoc().doc;
      const result = templates.fromBoard(aBoard({ id: SOURCE, template: true }));
      await settle();
      await answerPlugins(enabled);
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await result;
    }

    it('when a block has a disabled plugin type or an invalid prop then neither reaches the new document and the copy still succeeds', async () => {
      await copyUntrusted([]);

      const blocks = FakeConnection.writers[0]?.doc().blocks() ?? [];
      expect(blocks.map((b) => b.type).sort(), 'types written').toEqual([
        'core.sticky',
        'core.story',
      ]);
      expect(JSON.stringify(blocks), 'invalid colour').not.toContain('evil.test');
      expect(JSON.stringify(blocks), 'plugin data').not.toContain('plugin data');
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['2 blocks were not copied (unknown or disabled type, or invalid content).']);
    });

    it('when a block is left out then its connectors go with it and the others stay', async () => {
      await copyUntrusted([]);

      expect(FakeConnection.writers[0]?.doc().connectors().length, 'connectors written').toBe(1);
    });

    it('when the plugin is enabled on the instance then its block is copied with its props', async () => {
      await copyUntrusted([PLUGIN]);

      const blocks = FakeConnection.writers[0]?.doc().blocks() ?? [];
      expect(blocks.map((b) => b.type).sort(), 'types written').toEqual([
        'core.sticky',
        'core.story',
        'org.example.timer.clock',
      ]);
      expect(
        toasts.toasts().map((t) => t.message),
        'only the invalid block is reported',
      ).toEqual(['1 block was not copied (unknown or disabled type, or invalid content).']);
    });

    it('when the story card carried a poker round then the round id does not travel', async () => {
      await copyUntrusted([]);

      expect(JSON.stringify(FakeConnection.writers[0]?.doc().blocks()), 'round id').not.toContain(
        'round-secret',
      );
    });

    it('when the list of enabled plugins cannot be read then plugin blocks are left out', async () => {
      FakeConnection.content = untrustedDoc().doc;
      const result = templates.fromBoard(aBoard({ id: SOURCE, template: true }));
      await settle();
      expectRequest('GET', '/api/plugins', 'enabled plugins').flush(
        { code: 'INTERNAL_ERROR', status: 500 },
        { status: 500, statusText: 'Server Error' },
      );
      await settle();
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await result;

      expect(
        FakeConnection.writers[0]
          ?.doc()
          .blocks()
          .some((b) => b.type.startsWith('org.')),
        'plugin block written',
      ).toBe(false);
    });

    it('when the template comes from a newer format then nothing is created and a toast tells', async () => {
      const doc = templateDoc([]);
      doc.doc.getMap('meta').set('schemaVersion', 99);
      FakeConnection.content = doc;

      const result = templates.fromBoard(aBoard({ id: SOURCE, template: true }));
      await settle();
      await answerPlugins();

      expect(await result, 'result').toBeUndefined();
      expect(
        toasts.toasts().map((t) => t.kind),
        'toast kinds',
      ).toEqual(['error']);
    });

    it('when a built-in template is used then it is validated like an import and nothing is left out', async () => {
      const template = (await loadBuiltinTemplates())[2];
      const result = templates.fromBuiltin(template);
      await settle();
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await result;

      expect(written().length, 'blocks written').toBe(template.file.blocks.length);
      expect(toasts.toasts(), 'no toast').toEqual([]);
    });
  });

  describe('file rules', () => {
    async function start(ids: string[], options = {}): Promise<{ board: Promise<unknown> }> {
      FakeConnection.content = templateDoc(ids);
      const board = templates.fromBoard(
        aBoard({ id: SOURCE, title: 'Files', template: true }),
        options,
      );
      await settle();
      await answerPlugins();
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      return { board };
    }

    async function lookup(
      ids: string[],
      size = 4,
      kind: BoardFileKind = BoardFileKind.IMAGE,
    ): Promise<void> {
      expectRequest('GET', `/api/boards/${SOURCE}/files`, 'list').flush({
        items: ids.map((id) => ({ ...meta(id, `${id.slice(-1)}.png`), size, kind })),
      });
      await settle();
      expectRequest('GET', `/api/boards/${SOURCE}/files/urls`, 'urls').flush({
        items: ids.map(signedUrl),
      });
      await settle();
    }

    const upload = () =>
      TestBed.inject(HttpTestingController).expectOne(
        (r) => r.method === 'POST' && r.url === `/api/boards/${TARGET}/files`,
        'upload',
      );

    it('when the files are copied then only the original variant is requested', async () => {
      const { board } = await start([OLD_A]);

      await lookup([OLD_A]);
      upload().flush(stored(NEW_A, 'a.png'));
      await board;

      expect(
        fetchSpy.mock.calls.map((c: unknown[]) => String(c[0])),
        'urls fetched',
      ).toEqual([expect.stringContaining('v=original')]);
    });

    it('when the metadata is over the limits then the file is skipped without a download', async () => {
      const { board } = await start([OLD_A]);

      await lookup([OLD_A], MAX_FILE_BYTES + 1);
      await board;

      expect(fetchSpy.mock.calls.length, 'downloads').toBe(0);
      expect(writtenFileIds(), 'old id kept').toEqual([OLD_A]);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['1 of 1 file could not be copied. Its block shows “not available”.']);
    });

    it('when a video is bigger than an image limit but within the video limit then it is copied', async () => {
      const { board } = await start([OLD_A]);

      await lookup([OLD_A], MAX_FILE_BYTES + 1, BoardFileKind.VIDEO);
      upload().flush({ ...stored(NEW_A, 'a.mp4'), kind: BoardFileKind.VIDEO });
      await board;

      expect(writtenFileIds(), 'copied').toEqual([NEW_A]);
    });

    it('when the download answers 429 with Retry-After then it waits as told and tries again', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      templates.wait = wait;
      fetchSpy
        .mockImplementationOnce(() =>
          Promise.resolve(
            new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }),
          ),
        )
        .mockImplementation(() => Promise.resolve(new Response('data')));
      const { board } = await start([OLD_A]);

      await lookup([OLD_A]);
      upload().flush(stored(NEW_A, 'a.png'));
      await board;

      expect(wait, 'waited').toHaveBeenCalledWith(7000);
      expect(fetchSpy.mock.calls.length, 'downloads').toBe(2);
      expect(writtenFileIds(), 'copied').toEqual([NEW_A]);
    });

    it('when the upload answers 429 then it waits for Retry-After (capped) and tries again', async () => {
      const wait = vi.fn().mockResolvedValue(undefined);
      templates.wait = wait;
      const { board } = await start([OLD_A]);

      await lookup([OLD_A]);
      upload().flush(
        { code: 'TOO_MANY_REQUESTS', status: 429 },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '600' } },
      );
      await settle();
      upload().flush(stored(NEW_A, 'a.png'));
      await board;

      expect(wait, 'waited at most a minute').toHaveBeenCalledWith(60_000);
      expect(writtenFileIds(), 'copied').toEqual([NEW_A]);
      expect(toasts.toasts(), 'no toast').toEqual([]);
    });

    it('when 429 keeps coming then it gives up after the limit and counts the file as missing', async () => {
      templates.wait = vi.fn().mockResolvedValue(undefined);
      fetchSpy.mockImplementation(() => Promise.resolve(new Response('no', { status: 429 })));
      const { board } = await start([OLD_A]);

      await lookup([OLD_A]);
      await board;

      expect(fetchSpy.mock.calls.length, 'attempts').toBe(MAX_RATE_LIMIT_RETRIES + 1);
      expect(writtenFileIds(), 'old id kept').toEqual([OLD_A]);
    });

    it('when the template goes away during the copy then the copy is cancelled and the new board deleted', async () => {
      const { board } = await start([OLD_A]);

      expectRequest('GET', `/api/boards/${SOURCE}/files`, 'list').flush({
        items: [meta(OLD_A, 'a.png')],
      });
      await settle();
      // the server ends the template's session while the URLs are on their way
      FakeConnection.endSession();
      expectRequest('GET', `/api/boards/${SOURCE}/files/urls`, 'urls').flush({
        items: [signedUrl(OLD_A)],
      });
      await settle();
      expectRequest('DELETE', `/api/boards/${TARGET}`, 'discard').flush(null, {
        status: 204,
        statusText: 'No Content',
      });

      expect(await board, 'result').toBeUndefined();
      expect(fetchSpy.mock.calls.length, 'downloads').toBe(0);
      expect(FakeConnection.writers.length, 'nothing written').toBe(0);
    });

    it('when files are not wanted then their blocks are left out and no file is touched', async () => {
      FakeConnection.content = templateDoc([OLD_A]);
      const result = templates.fromBoard(aBoard({ id: SOURCE, template: true }), { files: false });
      await settle();
      await answerPlugins();
      expectRequest('POST', '/api/boards', 'create board').flush(aBoard({ id: TARGET }), {
        status: 201,
        statusText: 'Created',
      });
      await result;

      expect(written(), 'only the sticky').toEqual(['s1']);
      expect(toasts.toasts(), 'no toast: the user asked for it').toEqual([]);
    });

    it('when the file summary is asked then count and total size of the files are returned', async () => {
      const result = templates.fileSummary(aBoard({ id: SOURCE }));
      await settle();

      expectRequest('GET', `/api/boards/${SOURCE}/files`, 'list').flush({
        items: [
          { ...meta(OLD_A, 'a.png'), size: 1000 },
          { ...meta(OLD_B, 'b.png'), size: 2500 },
        ],
      });

      expect(await result, 'summary').toEqual({ count: 2, bytes: 3500 });
    });

    it('when the file list cannot be read then the summary is empty and no toast shows', async () => {
      const result = templates.fileSummary(aBoard({ id: SOURCE }));
      await settle();

      expectRequest('GET', `/api/boards/${SOURCE}/files`).flush(
        { code: 'INTERNAL_ERROR', status: 500 },
        { status: 500, statusText: 'Server Error' },
      );

      expect(await result, 'summary').toEqual({ count: 0, bytes: 0 });
      expect(toasts.toasts(), 'no toast').toEqual([]);
    });
  });
});
