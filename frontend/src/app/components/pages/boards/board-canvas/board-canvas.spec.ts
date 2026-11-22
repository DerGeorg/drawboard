import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BoardDoc } from '@apps/drawboard-engine';
import { Theme } from '../../../../services/theme';
import { all } from '../../../../test/dom';
import { FakeFileSource, FILE_ID } from '../../../../../board-engine/testing/fake-file-source';
import { BoardCanvas, CanvasFiles } from './board-canvas';

describe('BoardCanvas', () => {
  let fixture: ComponentFixture<BoardCanvas>;
  let board: BoardDoc;
  const readOnly = signal(false);
  const canUpload = signal(true);
  const source = new FakeFileSource();
  let received: CanvasFiles[];
  let diagrams: string[];

  async function render(): Promise<void> {
    board = new BoardDoc();
    received = [];
    diagrams = [];
    fixture = TestBed.createComponent(BoardCanvas, {
      bindings: [
        inputBinding('board', () => board),
        inputBinding('readOnly', readOnly),
        inputBinding('services', () => ({ files: source })),
        inputBinding('canUpload', canUpload),
        outputBinding<CanvasFiles>('files', (f) => received.push(f)),
        outputBinding<string>('diagram', (d) => diagrams.push(d)),
      ],
    });
    await fixture.whenStable();
  }

  /** jsdom has no DataTransfer: the parts of it the canvas reads. */
  function transfer(files: File[], text = ''): DataTransfer {
    return {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      files,
      types: files.length ? ['Files'] : [],
      dropEffect: 'none',
    } as unknown as DataTransfer;
  }

  function dragEvent(type: string, files: File[]): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: transfer(files), clientX: 10, clientY: 20 });
    return event;
  }

  function pasteEvent(files: File[], text = ''): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: transfer(files, text) });
    return event;
  }

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const png = (): File => new File(['x'], 'photo.png', { type: 'image/png' });

  beforeEach(() => {
    readOnly.set(false);
    canUpload.set(true);
  });
  afterEach(() => {
    board.destroy();
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  describe('engine', () => {
    it('when rendered then an engine runs on the surface and draws blocks of the board', async () => {
      await render();

      board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, text: 'hello' });

      expect(fixture.componentInstance.engine(), 'engine').toBeDefined();
      expect(all(fixture, '[data-block-type="core.sticky"]').length, 'rendered stickies').toBe(1);
    });

    it('when the board is replaced by a fresh document (version restored) then a new engine draws it and the old content is gone', async () => {
      await render();
      board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 100, h: 100, text: 'old' });
      const first = fixture.componentInstance.engine();

      const old = board;
      board = new BoardDoc();
      board.addBlock({ type: 'core.shape', x: 0, y: 0, w: 100, h: 100 });
      fixture.componentRef.changeDetectorRef.markForCheck();
      await fixture.whenStable();
      old.destroy();

      expect(fixture.componentInstance.engine(), 'engine instance').not.toBe(first);
      expect(all(fixture, '[data-block-type="core.sticky"]').length, 'old stickies').toBe(0);
      expect(all(fixture, '[data-block-type="core.shape"]').length, 'new shapes').toBe(1);
    });

    it('when the read-only flag changes then the engine follows', async () => {
      await render();

      readOnly.set(true);
      await fixture.whenStable();

      expect(fixture.componentInstance.engine()?.readOnly, 'engine read only').toBe(true);
    });

    it('when the theme changes then the engine draws the board in it and the document stays', async () => {
      await render();
      const id = board.addBlock({
        type: 'core.shape',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        props: { kind: 'rect', fill: '#ffffff' },
      });
      expect(fixture.componentInstance.engine()?.theme, 'starts light').toBe('light');

      await TestBed.inject(Theme).set('DARK');
      await fixture.whenStable();

      expect(fixture.componentInstance.engine()?.theme, 'engine theme').toBe('dark');
      expect(
        all(fixture, '[data-block-type="core.shape"] svg [fill]')[0]?.getAttribute('fill'),
        'shown',
      ).toBe('#1e293b');
      expect(board.getBlock(id)?.props['fill'], 'stored').toBe('#ffffff');
    });

    it('when the engine starts in a dark theme then it is dark from the first render', async () => {
      await TestBed.inject(Theme).set('DARK');

      await render();

      expect(fixture.componentInstance.engine()?.theme, 'engine theme').toBe('dark');
    });

    it('when destroyed then the engine layers are removed', async () => {
      await render();
      const surface = all(fixture, '[data-testid=canvas]')[0] as HTMLElement;

      fixture.destroy();

      expect(surface.children.length, 'children of the surface').toBe(0);
    });
  });

  describe('files', () => {
    it('when the services carry a file source then file blocks use it', async () => {
      await render();

      board.addBlock({ type: 'core.file', x: 0, y: 0, w: 100, h: 100, props: { fileId: FILE_ID } });

      expect(source.watching(FILE_ID), 'the block watches its file').toBe(1);
    });

    it('when files are dragged over then the drop is allowed as a copy', async () => {
      await render();
      const over = dragEvent('dragover', [png()]);

      host().dispatchEvent(over);

      expect(over.defaultPrevented, 'drop allowed').toBe(true);
      expect((over as DragEvent).dataTransfer?.dropEffect, 'copy').toBe('copy');
    });

    it('when files are dropped then they go out with the world point of the drop', async () => {
      await render();
      const drop = dragEvent('drop', [png()]);

      host().dispatchEvent(drop);

      expect(drop.defaultPrevented, 'browser does not open the file').toBe(true);
      expect(
        received[0]?.files.map((f) => f.name),
        'files',
      ).toEqual(['photo.png']);
      expect(received[0]?.at, 'world point').toEqual({ x: 10, y: 20 });
    });

    it('when uploading is not allowed then drops and pastes are left alone', async () => {
      canUpload.set(false);
      await render();

      const over = dragEvent('dragover', [png()]);
      host().dispatchEvent(over);
      host().dispatchEvent(dragEvent('drop', [png()]));
      document.dispatchEvent(pasteEvent([png()]));

      expect(over.defaultPrevented, 'no drop target').toBe(false);
      expect(received.length, 'nothing').toBe(0);
    });

    it('when an image is pasted outside a text field then it goes out without a point', async () => {
      await render();

      document.dispatchEvent(pasteEvent([png()]));

      expect(received[0]?.files.length, 'pasted').toBe(1);
      expect(received[0]?.at, 'middle of the view').toBeUndefined();
    });

    it('when something is pasted into a text field then the canvas ignores it', async () => {
      await render();
      const input = document.createElement('textarea');
      document.body.appendChild(input);

      input.dispatchEvent(pasteEvent([png()]));
      document.dispatchEvent(pasteEvent([]));

      expect(received.length, 'ignored').toBe(0);
      input.remove();
    });
  });

  describe('diagrams', () => {
    it('when a mermaid code fence is pasted then its source goes out', async () => {
      await render();
      const paste = pasteEvent([], '```mermaid\nflowchart LR\n  A --> B\n```\n');

      document.dispatchEvent(paste);

      expect(diagrams, 'source').toEqual(['flowchart LR\n  A --> B']);
      expect(paste.defaultPrevented, 'taken').toBe(true);
    });

    it('when board content is pasted then the canvas leaves it to the engine, even with a fence as text', async () => {
      await render();
      const source = fixture.componentInstance.engine();
      const id = board.addBlock({
        type: 'core.sticky',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        text: '```mermaid\ngraph TD\n```',
      });
      source?.selection.set([id]);
      const content = source?.copySelection();
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.assign(paste, {
        clipboardData: {
          types: ['application/x-drawboard+json', 'text/plain'],
          files: [],
          getData: (type: string) =>
            type === 'application/x-drawboard+json' ? content?.json : content?.text,
        },
      });

      document.dispatchEvent(paste);

      expect(diagrams, 'no diagram').toEqual([]);
      expect(board.blocks().length, 'the engine pasted a copy').toBe(2);
      expect(paste.defaultPrevented, 'taken by the engine').toBe(true);
    });

    it('when other text is pasted or the board is read-only then nothing happens', async () => {
      await render();

      document.dispatchEvent(pasteEvent([], 'just text'));
      readOnly.set(true);
      await fixture.whenStable();
      document.dispatchEvent(pasteEvent([], '```mermaid\ngraph TD\n```'));

      expect(diagrams, 'nothing').toEqual([]);
    });
  });
});
