import { BoardEngine } from '../engine';
import { BoardDoc } from '../model/board-doc';
import { BlockData } from '../model/types';
import { FakeFileSource, FILE_ID, aFileMeta, someLinks } from '../testing/fake-file-source';
import {
  FILE_TYPE,
  INTERACTIVE_ATTR,
  MACRO_HINT,
  createFileBlock,
  fileBlockSize,
  fileIdOf,
  formatSize,
} from './file';

const aBlock = (props: Record<string, unknown> = { fileId: FILE_ID }): BlockData => ({
  id: 'b1',
  type: FILE_TYPE,
  x: 0,
  y: 0,
  w: 320,
  h: 240,
  rotation: 0,
  z: 1,
  parent: null,
  locked: false,
  props,
  hasText: false,
});

describe('file block', () => {
  let source: FakeFileSource;
  let host: HTMLElement;

  beforeEach(() => {
    source = new FakeFileSource();
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  const render = (block = aBlock(), pdf?: Parameters<typeof createFileBlock>[1]) =>
    createFileBlock(source, pdf).render(host, { block, text: () => '', readOnly: false });
  const q = <T extends Element = HTMLElement>(sel: string): T | null => host.querySelector<T>(sel);

  describe('states', () => {
    it('when the file is not known yet then the block says it is loading', () => {
      render();

      expect(host.textContent, 'loading text').toContain('Loading file');
      expect(source.watching(FILE_ID), 'the block follows its file').toBe(1);
    });

    it('when the file is missing then the block says so and offers no download', () => {
      render();

      source.emit(FILE_ID, { status: 'missing' });

      expect(host.textContent, 'missing text').toContain('not available');
      expect(q('.be-file-download'), 'no download').toBeNull();
    });

    it('when the props hold no valid file id then nothing is watched', () => {
      render(aBlock({ fileId: '/files/x?sig=1' }));

      expect(source.watchers.size, 'no watch').toBe(0);
      expect(host.textContent, 'missing').toContain('not available');
    });

    it('when the source fails then the block says it retries', () => {
      render();

      source.emit(FILE_ID, { status: 'error' });

      expect(host.textContent, 'error text').toContain('Retrying');
    });
  });

  describe('image', () => {
    it('when an image is ready then it shows with its name as alt text and no referrer', () => {
      render();

      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(1) });

      const img = q<HTMLImageElement>('img');
      expect(img?.getAttribute('src'), 'signed url').toBe(someLinks(1).url);
      expect(img?.alt, 'alt').toBe('photo.png');
      expect(img?.referrerPolicy, 'referrer').toBe('no-referrer');
      expect(q('.be-file-name')?.textContent, 'caption').toBe('photo.png');
    });

    it('when the URLs are renewed then a loaded image keeps its source', () => {
      render();
      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(1) });

      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(2) });

      expect(q('img')?.getAttribute('src'), 'unchanged').toBe(someLinks(1).url);
    });

    it('when the image fails to load then new URLs are asked for once and used', () => {
      render();
      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(1) });

      q('img')?.dispatchEvent(new Event('error'));
      q('img')?.dispatchEvent(new Event('error'));
      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(2) });

      expect(source.refreshes, 'one refresh').toEqual([FILE_ID]);
      expect(q('img')?.getAttribute('src'), 'new url').toBe(someLinks(2).url);
    });

    it('when a file name holds markup then it is shown as text', () => {
      render();

      source.emit(FILE_ID, {
        status: 'ready',
        file: aFileMeta({ name: '<img src=x onerror=alert(1)>.png' }),
        links: someLinks(1),
      });

      expect(host.querySelectorAll('img').length, 'only the file image').toBe(1);
      expect(q('.be-file-name')?.textContent, 'name as text').toContain('<img');
    });
  });

  describe('video', () => {
    it('when a video is ready then it has controls and takes its own pointer input', () => {
      render();

      source.emit(FILE_ID, {
        status: 'ready',
        file: aFileMeta({ kind: 'VIDEO', name: 'clip.mp4' }),
        links: someLinks(1),
      });

      const video = q<HTMLVideoElement>('video');
      expect(video?.controls, 'controls').toBe(true);
      expect(video?.hasAttribute(INTERACTIVE_ATTR), 'interactive').toBe(true);
      expect(video?.getAttribute('src'), 'url').toBe(someLinks(1).url);
    });

    it('when the video fails mid-play then it continues with new URLs', () => {
      render();
      const file = aFileMeta({ kind: 'VIDEO' });
      source.emit(FILE_ID, { status: 'ready', file, links: someLinks(1) });

      q('video')?.dispatchEvent(new Event('error'));
      source.emit(FILE_ID, { status: 'ready', file, links: someLinks(2) });
      source.emit(FILE_ID, { status: 'ready', file, links: someLinks(3) });

      expect(source.refreshes, 'refresh').toEqual([FILE_ID]);
      expect(q('video')?.getAttribute('src'), 'renewed once').toBe(someLinks(2).url);
    });
  });

  describe('documents and cards', () => {
    it('when an Office document is converting then the card says so', () => {
      render();

      source.emit(FILE_ID, {
        status: 'ready',
        file: aFileMeta({ kind: 'DOCUMENT', conversion: 'PENDING', name: 'plan.docx' }),
        links: someLinks(1),
      });

      expect(host.textContent, 'pending').toContain('Converting to PDF');
      expect(q('.be-file-download')?.getAttribute('title'), 'macro hint').toContain(MACRO_HINT);
    });

    it('when the conversion failed then the card warns about macros', () => {
      render();

      source.emit(FILE_ID, {
        status: 'ready',
        file: aFileMeta({ kind: 'DOCUMENT', conversion: 'FAILED' }),
        links: someLinks(1),
      });

      expect(host.textContent, 'failed').toContain('conversion failed');
      expect(host.textContent, 'hint').toContain(MACRO_HINT);
    });

    it('when a PDF arrives without a PDF renderer then a card with the page count shows', () => {
      render();

      source.emit(FILE_ID, {
        status: 'ready',
        file: aFileMeta({ kind: 'PDF', size: 1_500_000, pageCount: 3 }),
        links: someLinks(1),
      });

      expect(host.textContent, 'card').toContain('1.5 MB · 3 pages');
    });

    it('when the conversion finishes then the PDF renderer replaces the card', () => {
      const pdf = vi.fn(() => ({ update: vi.fn(), destroy: vi.fn() }));
      render(aBlock(), { pdf });
      const pending = aFileMeta({ kind: 'DOCUMENT', conversion: 'PENDING' });
      source.emit(FILE_ID, { status: 'ready', file: pending, links: someLinks(1) });

      source.emit(FILE_ID, {
        status: 'ready',
        file: { ...pending, conversion: 'DONE', pageCount: 1 },
        links: someLinks(2, { pdfUrl: '/files/p' }),
      });

      expect(pdf, 'renderer used for the converted PDF').toHaveBeenCalledTimes(1);
    });
  });

  describe('download and lifecycle', () => {
    it('when the download button is clicked then the source downloads the file', () => {
      render();
      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(1) });

      const button = q<HTMLButtonElement>('.be-file-download');
      button?.click();

      expect(source.downloads, 'download').toEqual([FILE_ID]);
      expect(button?.hasAttribute(INTERACTIVE_ATTR), 'button takes the click').toBe(true);
      expect(button?.getAttribute('aria-label'), 'label').toBe('Download photo.png');
    });

    it('when the block points to another file then the old one is no longer watched', () => {
      const view = render();
      const other = '0192f5e0-7c1a-7b3e-8f00-000000000002';

      view.update(aBlock({ fileId: other }));

      expect(source.watching(FILE_ID), 'old').toBe(0);
      expect(source.watching(other), 'new').toBe(1);
    });

    it('when the view is destroyed then it stops watching and leaves no element', () => {
      const view = render();

      view.destroy();

      expect(source.watching(FILE_ID), 'unwatched').toBe(0);
      expect(host.children.length, 'empty').toBe(0);
    });
  });

  describe('helpers', () => {
    it('when a new block is sized then images keep their aspect ratio below 480 units', () => {
      expect(fileBlockSize({ kind: 'IMAGE', width: 1600, height: 800 }), 'scaled').toEqual({
        w: 480,
        h: 268,
      });
      expect(fileBlockSize({ kind: 'IMAGE', width: 100, height: 50 }), 'small').toEqual({
        w: 100,
        h: 78,
      });
      expect(fileBlockSize({ kind: 'PDF' }), 'pdf').toEqual({ w: 360, h: 480 });
      expect(fileBlockSize({ kind: 'VIDEO' }), 'video without size').toEqual({ w: 480, h: 298 });
      expect(fileBlockSize({ kind: 'DOCUMENT' }), 'document').toEqual({ w: 360, h: 480 });
    });

    it('when a file id is read then only a UUID counts, in lower case', () => {
      expect(fileIdOf(aBlock({ fileId: FILE_ID.toUpperCase() })), 'upper').toBe(FILE_ID);
      expect(fileIdOf(aBlock({ fileId: 5 })), 'number').toBeUndefined();
    });

    it('when sizes are formatted then decimal units are used', () => {
      expect(formatSize(512), 'bytes').toBe('512 B');
      expect(formatSize(3400), 'kB').toBe('3.4 kB');
      expect(formatSize(-1), 'invalid').toBe('');
    });
  });

  describe('in the engine', () => {
    it('when a file block is inserted then the document holds the file id and never a URL', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const board = new BoardDoc();
      const engine = new BoardEngine(container, board, { services: { files: source } });

      const id = engine.insertBlock({
        type: FILE_TYPE,
        at: { x: 100, y: 100 },
        size: { w: 200, h: 100 },
        props: { fileId: FILE_ID },
      });
      source.emit(FILE_ID, { status: 'ready', file: aFileMeta(), links: someLinks(1) });

      expect(board.getBlock(id ?? '')?.props, 'props').toEqual({ fileId: FILE_ID });
      expect(JSON.stringify(board.doc.toJSON()), 'no signed URL in the document').not.toContain(
        'sig=',
      );
      expect(container.querySelector('img')?.getAttribute('src'), 'rendered').toContain('/files/');
      expect(board.getBlock(id ?? '')?.x, 'centred').toBe(0);
      engine.destroy();
      board.destroy();
      container.remove();
    });

    it('when the board is read-only then nothing is inserted', () => {
      const container = document.createElement('div');
      const board = new BoardDoc();
      const engine = new BoardEngine(container, board, { readOnly: true });

      expect(
        engine.insertBlock({ type: FILE_TYPE, at: { x: 0, y: 0 }, props: { fileId: FILE_ID } }),
        'refused',
      ).toBeUndefined();
      expect(
        engine.insertBlock({ type: 'no.such', at: { x: 0, y: 0 } }),
        'unknown',
      ).toBeUndefined();
      engine.destroy();
      board.destroy();
    });
  });
});
