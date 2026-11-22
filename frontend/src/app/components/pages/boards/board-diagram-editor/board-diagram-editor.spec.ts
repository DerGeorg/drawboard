import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import * as Y from 'yjs';

import { MAX_MERMAID_BYTES, MERMAID_TYPE, BoardDoc } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../board-engine/engine';
import { buttonByLabel, textOf } from '../../../../test/dom';
import { BoardDiagramEditor } from './board-diagram-editor';

describe('BoardDiagramEditor', () => {
  let fixture: ComponentFixture<BoardDiagramEditor>;
  let board: BoardDoc;
  let engine: BoardEngine;
  let id: string;
  let closed: number;

  async function render(readOnly = false): Promise<void> {
    board = new BoardDoc();
    engine = new BoardEngine(document.createElement('div'), board, { readOnly });
    id = board.addBlock({ type: MERMAID_TYPE, x: 0, y: 0, w: 100, h: 100, text: 'graph TD' });
    closed = 0;
    fixture = TestBed.createComponent(BoardDiagramEditor, {
      bindings: [
        inputBinding('engine', () => engine),
        inputBinding('blockId', () => id),
        outputBinding('closed', () => closed++),
      ],
    });
    await fixture.whenStable();
  }

  const area = (): HTMLTextAreaElement =>
    (fixture.nativeElement as HTMLElement).querySelector('textarea') as HTMLTextAreaElement;

  function type(value: string): void {
    area().value = value;
    area().dispatchEvent(new Event('input'));
  }

  afterEach(() => {
    engine.destroy();
    board.destroy();
  });

  describe('editing', () => {
    it('when opened then the source of the block is shown with its size', async () => {
      await render();

      expect(area().value, 'source').toBe('graph TD');
      expect(textOf(fixture), 'size').toContain('8 B of 50 kB');
    });

    it('when the source is typed then the block text follows', async () => {
      await render();

      type('graph TD; A-->B');

      expect(board.textOf(id), 'written').toBe('graph TD; A-->B');
    });

    it('when the source would grow past 50 KB then nothing is written and the panel says so', async () => {
      await render();

      type('x'.repeat(MAX_MERMAID_BYTES + 1));
      await fixture.whenStable();

      expect(board.textOf(id), 'unchanged').toBe('graph TD');
      expect(textOf(fixture), 'message').toContain('was not saved');
    });

    it('when someone else changes the source then the panel shows it', async () => {
      await render();
      const remote = new BoardDoc(new Y.Doc(), false);
      Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(board.doc));
      remote.doc.on('update', (u: Uint8Array) => Y.applyUpdate(board.doc, u, 'remote'));

      remote.getText(id)?.insert(8, '; X-->Y');
      await fixture.whenStable();

      expect(board.textOf(id), 'arrived').toBe('graph TD; X-->Y');
      expect(area().value, 'remote edit').toBe('graph TD; X-->Y');
      remote.destroy();
    });

    it('when the board is read-only then the source cannot be changed', async () => {
      await render(true);

      expect(area().readOnly, 'read only').toBe(true);
    });
  });

  describe('closing', () => {
    it('when the block is deleted then the panel closes', async () => {
      await render();

      board.deleteItems([id]);

      expect(closed, 'closed').toBe(1);
    });

    it('when the close button is clicked then the panel closes', async () => {
      await render();

      buttonByLabel(fixture, 'Close the diagram source').click();

      expect(closed, 'closed').toBe(1);
    });
  });
});
