import * as Y from 'yjs';

import { BoardDoc } from '../model/board-doc';
import { applyTextDiff, startTextEditor, textDiff, transformIndex } from './text-editor';

describe('text-editor', () => {
  describe('textDiff', () => {
    it.each([
      ['abc', 'abXc', { index: 2, remove: 0, insert: 'X' }],
      ['abc', 'ac', { index: 1, remove: 1, insert: '' }],
      ['abc', 'aXc', { index: 1, remove: 1, insert: 'X' }],
      ['', 'hi', { index: 0, remove: 0, insert: 'hi' }],
      ['hi', '', { index: 0, remove: 2, insert: '' }],
      ['same', 'same', { index: 4, remove: 0, insert: '' }],
      ['aaa', 'aa', { index: 2, remove: 1, insert: '' }],
    ])('when %j becomes %j then the minimal edit is found', (before, after, expected) => {
      expect(textDiff(before, after), 'diff').toEqual(expected);
    });
  });

  describe('transformIndex', () => {
    it('when text is inserted before the caret then the caret shifts', () => {
      expect(transformIndex([{ insert: 'abc' }], 2), 'caret').toBe(5);
    });

    it('when text is inserted after the caret then the caret stays', () => {
      expect(transformIndex([{ retain: 5 }, { insert: 'abc' }], 2), 'caret').toBe(2);
    });

    it('when text is deleted before the caret then the caret moves back, and not below the deletion', () => {
      expect(transformIndex([{ retain: 1 }, { delete: 4 }], 3), 'caret inside the deletion').toBe(
        1,
      );
      expect(transformIndex([{ delete: 2 }], 5), 'caret after the deletion').toBe(3);
    });

    it('when an embed is inserted then it counts as one character', () => {
      expect(transformIndex([{ insert: {} }], 0), 'caret').toBe(1);
    });
  });

  describe('applyTextDiff', () => {
    it('when the value changes then only the difference is written, in the local origin', () => {
      const board = new BoardDoc();
      const id = board.addBlock({ type: 't', x: 0, y: 0, w: 1, h: 1, text: 'hello world' });
      const ytext = board.getText(id) as Y.Text;
      const deltas: unknown[] = [];
      ytext.observe((e) => deltas.push(e.delta));

      applyTextDiff(board, ytext, 'hello brave world');
      applyTextDiff(board, ytext, 'hello brave world');

      expect(ytext.toString(), 'text').toBe('hello brave world');
      expect(deltas, 'one delta: an insert in the middle').toEqual([
        [{ retain: 6 }, { insert: 'brave ' }],
      ]);
      board.destroy();
    });

    it('when the diff replaces text then both a delete and an insert are written', () => {
      const board = new BoardDoc();
      const id = board.addBlock({ type: 't', x: 0, y: 0, w: 1, h: 1, text: 'abc' });

      applyTextDiff(board, board.getText(id) as Y.Text, 'aXc');

      expect(board.textOf(id), 'text').toBe('aXc');
      board.destroy();
    });
  });

  describe('startTextEditor', () => {
    function setup(): { board: BoardDoc; id: string; host: HTMLElement; stopped: () => number } {
      const board = new BoardDoc();
      const id = board.addBlock({ type: 't', x: 0, y: 0, w: 1, h: 1, text: 'one two' });
      const host = document.createElement('div');
      document.body.appendChild(host);
      let stops = 0;
      const session = startTextEditor(board, host, id, () => stops++);
      expect(session?.blockId, 'session').toBe(id);
      return { board, id, host, stopped: () => stops };
    }

    it('when started then a textarea with the current text is shown; stop removes it once', () => {
      const { board, host, stopped } = setup();
      const ta = host.querySelector('textarea') as HTMLTextAreaElement;

      expect(ta.value, 'value').toBe('one two');
      expect(ta.maxLength, 'max length').toBe(100_000);
      ta.blur();
      ta.blur();

      expect(host.querySelector('textarea'), 'removed').toBeNull();
      expect(stopped(), 'stopped once').toBe(1);
      board.destroy();
    });

    it('when a remote edit arrives then the value updates and the caret moves with the text', () => {
      const { board, id, host } = setup();
      const ta = host.querySelector('textarea') as HTMLTextAreaElement;
      ta.setSelectionRange(7, 7);

      Y.applyUpdate(board.doc, remoteInsert(board, id, 0, 'ZZ '), 'remote');

      expect(ta.value, 'value').toBe('ZZ one two');
      expect(ta.selectionStart, 'caret').toBe(10);
      board.destroy();
    });

    it('when the local user types then the text arrives in the Y.Text', () => {
      const { board, id, host } = setup();
      const ta = host.querySelector('textarea') as HTMLTextAreaElement;
      ta.value = 'one! two';
      ta.dispatchEvent(new Event('input'));

      expect(board.textOf(id), 'text').toBe('one! two');
      board.destroy();
    });

    it('when Escape is pressed then the editor stops and the key does not bubble to the engine', () => {
      const { board, host, stopped } = setup();
      const outer = vi.fn();
      host.addEventListener('keydown', outer);

      host
        .querySelector('textarea')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(stopped(), 'stopped').toBe(1);
      expect(outer, 'bubbled').not.toHaveBeenCalled();
      board.destroy();
    });

    describe('insert and hold', () => {
      function start(maxLength?: number): ReturnType<typeof setup> & {
        session: NonNullable<ReturnType<typeof startTextEditor>>;
        ta: HTMLTextAreaElement;
      } {
        const board = new BoardDoc();
        const id = board.addBlock({ type: 't', x: 0, y: 0, w: 1, h: 1, text: 'one two' });
        const host = document.createElement('div');
        document.body.appendChild(host);
        let stops = 0;
        const session = startTextEditor(board, host, id, () => stops++, { maxLength });
        return {
          board,
          id,
          host,
          stopped: () => stops,
          session: session as NonNullable<typeof session>,
          ta: host.querySelector('textarea') as HTMLTextAreaElement,
        };
      }

      it('when text is inserted then it goes in at the caret as one edit in the Y.Text', () => {
        const { board, id, session, ta } = start();
        ta.setSelectionRange(3, 3);
        const deltas: unknown[] = [];
        board.getText(id)?.observe((e) => deltas.push(e.delta));

        const inserted = session.insert('🎉');

        expect(inserted, 'result').toBe(true);
        expect(board.textOf(id), 'text').toBe('one🎉 two');
        expect(deltas, 'one delta').toEqual([[{ retain: 3 }, { insert: '🎉' }]]);
        expect(ta.selectionStart, 'caret after the insert').toBe(5);
        board.destroy();
      });

      it('when text is selected then the insert replaces it', () => {
        const { board, id, session, ta } = start();
        ta.setSelectionRange(4, 7);

        session.insert('🎉');

        expect(board.textOf(id), 'text').toBe('one 🎉');
        board.destroy();
      });

      it('when the insert would exceed the limit then nothing changes', () => {
        const { board, id, session } = start(8);

        expect(session.insert('🎉'), 'fits 8 units? 7 + 2').toBe(false);
        expect(board.textOf(id), 'text').toBe('one two');
        board.destroy();
      });

      it('when the editor is one line then line breaks become spaces', () => {
        const { board, id, session } = start(50);

        session.insert('a\nb');

        expect(board.textOf(id), 'text').toBe('one twoa b');
        board.destroy();
      });

      it('when the editor has ended then insert does nothing', () => {
        const { board, id, session } = start();
        session.stop();

        expect(session.insert('🎉'), 'result').toBe(false);
        expect(board.textOf(id), 'text').toBe('one two');
        board.destroy();
      });

      it('when the editor is held then blur does not end it, and release gives the focus back', () => {
        const { board, host, session, ta, stopped } = start();
        ta.setSelectionRange(2, 2);
        const release = session.hold();
        const other = document.createElement('input');
        host.appendChild(other);

        other.focus();
        expect(stopped(), 'stopped while held').toBe(0);
        expect(host.querySelector('textarea'), 'editor while held').not.toBeNull();

        release();
        release();
        expect(document.activeElement, 'focus').toBe(ta);
        expect(ta.selectionStart, 'caret kept').toBe(2);
        ta.blur();
        expect(stopped(), 'stopped after release and blur').toBe(1);
        board.destroy();
      });

      it('when the editor ends while held then release does not bring it back', () => {
        const { board, host, session } = start();
        const release = session.hold();

        session.stop();
        release();

        expect(host.querySelector('textarea'), 'editor').toBeNull();
        board.destroy();
      });
    });

    it('when the block has no text then no editor is created', () => {
      const board = new BoardDoc();
      const id = board.addBlock({ type: 't', x: 0, y: 0, w: 1, h: 1 });

      expect(
        startTextEditor(board, document.createElement('div'), id, () => undefined),
        'session',
      ).toBeUndefined();
      board.destroy();
    });
  });
});

function remoteInsert(board: BoardDoc, id: string, index: number, text: string): Uint8Array {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(board.doc));
  const before = Y.encodeStateVector(other);
  (other.getMap('blocks').get(id) as Y.Map<unknown>).get('text');
  ((other.getMap('blocks').get(id) as Y.Map<unknown>).get('text') as Y.Text).insert(index, text);
  return Y.encodeStateAsUpdate(other, before);
}
