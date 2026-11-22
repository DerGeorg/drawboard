import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BoardFile, BoardFileConversion, BoardFileKind, FileUrl } from '@apps/drawboard-api';

import type { FileState } from '@apps/drawboard-engine';
import { signedInAsAlice } from '../../../test/fake-auth';
import { SPRINT_BOARD_ID } from '../../../test/fixtures';
import { expectRequest, provideHttpTesting } from '../../../test/http-testing';
import { provideTestRuntimeConfig } from '../../../test/runtime-config';
import { BoardFiles, POLL_FIRST_MS, RENEW_BEFORE_MS, RETRY_MS } from './board-files';

const FILE_ID = '0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f';
const OTHER_ID = '0192f5e0-7c1a-7b3e-8f00-000000000002';
const FILES = `/api/boards/${SPRINT_BOARD_ID}/files`;

function aFile(overrides: Partial<BoardFile> = {}): BoardFile {
  return {
    id: FILE_ID,
    boardId: SPRINT_BOARD_ID,
    name: 'photo.png',
    mediaType: 'image/png',
    kind: BoardFileKind.IMAGE,
    size: 2048,
    createdAt: '2026-11-10T10:00:00Z',
    conversion: BoardFileConversion.NONE,
    width: 800,
    height: 600,
    ...overrides,
  };
}

function aUrl(id = FILE_ID, sig = 's1', expiresInMs = 3_600_000): FileUrl {
  return {
    fileId: id,
    url: `/files/${id}?v=original&exp=1&sig=${sig}`,
    originalUrl: `/files/${id}?v=original&exp=1&sig=${sig}`,
    thumbnailUrl: `/files/${id}?v=thumbnail&exp=1&sig=${sig}`,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

describe('BoardFiles', () => {
  let files: BoardFiles;
  let http: HttpTestingController;

  function setUp(filesOrigin?: string): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpTesting(),
        provideTestRuntimeConfig({ filesOrigin }),
        signedInAsAlice().providers,
        BoardFiles,
      ],
    });
    files = TestBed.inject(BoardFiles);
    http = TestBed.inject(HttpTestingController);
    files.open(SPRINT_BOARD_ID);
  }

  /** Lets the token interceptor and the microtask batch run. */
  const tick = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  function watch(id = FILE_ID): FileState[] {
    const states: FileState[] = [];
    files.watch(id, (s) => states.push(s));
    return states;
  }

  const expectUrls = (ids: string) =>
    http.expectOne(
      (r) =>
        r.url === `${FILES}/urls` && decodeURIComponent(r.urlWithParams).endsWith(`ids=${ids}`),
      `urls ${ids}`,
    );

  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  describe('watch', () => {
    it('when a file is watched then metadata and signed URLs arrive in one list and one URL call', async () => {
      setUp();
      const states = watch();
      await tick();

      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();

      const last = states.at(-1);
      expect(states[0]?.status, 'first loading').toBe('loading');
      expect(last?.status, 'ready').toBe('ready');
      expect(last?.status === 'ready' && last.links.url, 'url as given').toBe(aUrl().url);
      expect(last?.status === 'ready' && last.file.name, 'name').toBe('photo.png');
    });

    it('when several files mount at once then their URLs come in one batch', async () => {
      setUp();
      watch(FILE_ID);
      watch(OTHER_ID);
      await tick();
      expectRequest('GET', FILES, 'list').flush({
        items: [aFile(), aFile({ id: OTHER_ID })],
      });
      await tick();

      const req = expectUrls(`${FILE_ID},${OTHER_ID}`);
      expect(req.request.method, 'one GET for both').toBe('GET');
      req.flush({ items: [aUrl(), aUrl(OTHER_ID)] });
    });

    it('when a file is not in the list then it is fetched alone and a 404 makes it missing', async () => {
      setUp();
      const states = watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [] });
      await tick();

      expectRequest('GET', `${FILES}/${FILE_ID}`, 'get one').flush(
        { code: 'FILES_FILE_NOT_FOUND', status: 404 },
        { status: 404, statusText: 'Not Found' },
      );
      await tick();

      expect(states.at(-1)?.status, 'missing').toBe('missing');
    });

    it('when the URL answer leaves the file out then it is missing', async () => {
      setUp();
      const states = watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();

      expectUrls(FILE_ID).flush({ items: [] });
      await tick();

      expect(states.at(-1)?.status, 'missing').toBe('missing');
    });

    it('when the API hands out a URL to another host then it is not used', async () => {
      setUp();
      const states = watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();

      expectUrls(FILE_ID).flush({
        items: [{ ...aUrl(), url: 'https://evil.example/files/x?sig=1' }],
      });
      await tick();

      expect(states.at(-1)?.status, 'refused').toBe('missing');
    });

    it('when a files origin is configured then the paths are put on it', async () => {
      setUp('https://files.example.org');
      const states = watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();

      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();

      const last = states.at(-1);
      expect(last?.status === 'ready' && last.links.url, 'absolute').toBe(
        `https://files.example.org${aUrl().url}`,
      );
    });

    it('when the list fails then the block shows an error and the load is tried again', async () => {
      setUp();
      const states = watch();
      await tick();

      expectRequest('GET', FILES, 'list').flush(
        { code: 'INTERNAL_ERROR', status: 500 },
        { status: 500, statusText: 'Error' },
      );
      await tick();
      expect(states.at(-1)?.status, 'error').toBe('error');

      await tick(RETRY_MS);
      expectRequest('GET', FILES, 'list again').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();
      expect(states.at(-1)?.status, 'recovered').toBe('ready');
    });
  });

  describe('renewal', () => {
    it('when the URLs come close to their expiry then new ones are fetched before', async () => {
      setUp();
      const states = watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl(FILE_ID, 's1', 3_600_000)] });
      await tick();

      await tick(3_600_000 - RENEW_BEFORE_MS - 1_000);
      http.expectNone(`${FILES}/urls`, 'not yet');
      await tick(1_000);
      expectUrls(FILE_ID).flush({ items: [aUrl(FILE_ID, 's2')] });
      await tick();

      const last = states.at(-1);
      expect(last?.status === 'ready' && last.links.url, 'renewed').toContain('sig=s2');
    });

    it('when nobody shows a file any more then its URLs are not renewed', async () => {
      setUp();
      const off = files.watch(FILE_ID, () => undefined);
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();

      off();
      await tick(3_600_000);

      http.expectNone(`${FILES}/urls`, 'no renewal');
      expect(http.match(() => true).length, 'no request at all').toBe(0);
    });

    it('when a view reports a failed load then new URLs are fetched at once', async () => {
      setUp();
      watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();

      files.refresh(FILE_ID);
      await tick();

      const req = expectUrls(FILE_ID);
      expect(req.request.method, 'fetched again at once').toBe('GET');
      req.flush({ items: [aUrl(FILE_ID, 's2')] });
    });
  });

  describe('conversion', () => {
    it('when a document is converting then it is polled until done and then gets its PDF URL', async () => {
      setUp();
      const pending = aFile({
        kind: BoardFileKind.DOCUMENT,
        name: 'plan.docx',
        conversion: BoardFileConversion.PENDING,
      });
      const states = watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [pending] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();

      await tick(POLL_FIRST_MS);
      expectRequest('GET', `${FILES}/${FILE_ID}`, 'poll 1').flush(pending);
      await tick(POLL_FIRST_MS * 1.5);
      expectRequest('GET', `${FILES}/${FILE_ID}`, 'poll 2').flush({
        ...pending,
        conversion: BoardFileConversion.DONE,
        pageCount: 4,
      });
      await tick();
      expectUrls(FILE_ID).flush({
        items: [{ ...aUrl(), pdfUrl: `/files/${FILE_ID}?v=pdf&sig=p` }],
      });
      await tick();

      const last = states.at(-1);
      expect(last?.status === 'ready' && last.file.conversion, 'done').toBe('DONE');
      expect(last?.status === 'ready' && last.links.pdfUrl, 'pdf url').toContain('v=pdf');
    });
  });

  describe('download', () => {
    it('when a file is downloaded then a link to the original with its name is clicked', async () => {
      setUp();
      watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl()] });
      await tick();
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        /* no navigation in jsdom */
      });

      await files.download(FILE_ID);

      const a = click.mock.contexts[0] as HTMLAnchorElement;
      expect(a.getAttribute('href'), 'original').toBe(aUrl().originalUrl);
      expect(a.download, 'file name').toBe('photo.png');
      expect(a.rel, 'no opener').toBe('noopener noreferrer');
      click.mockRestore();
    });

    it('when the URLs are about to expire then the download fetches fresh ones first', async () => {
      setUp();
      watch();
      await tick();
      expectRequest('GET', FILES, 'list').flush({ items: [aFile()] });
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl(FILE_ID, 's1', 10_000)] });
      await tick();
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
        /* no navigation in jsdom */
      });

      const done = files.download(FILE_ID);
      await tick();
      expectUrls(FILE_ID).flush({ items: [aUrl(FILE_ID, 'fresh')] });
      await done;

      expect((click.mock.contexts[0] as HTMLAnchorElement).href, 'fresh').toContain('sig=fresh');
      click.mockRestore();
    });
  });
});
