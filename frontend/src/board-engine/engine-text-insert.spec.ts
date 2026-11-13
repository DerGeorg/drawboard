import { SelectionAnchor } from './engine';
import { TestEngine, createTestEngine } from './testing/helpers';

describe('inserting into an edited text (emoji button)', () => {
  let t: TestEngine;
  let id: string;
  beforeEach(() => {
    t = createTestEngine();
    id = t.board.addBlock({
      type: 'core.sticky',
      x: 100,
      y: 50,
      w: 200,
      h: 200,
      props: { color: '#fde68a' },
      text: 'hello',
    });
    t.engine.flush();
    // the block above is its own undo step, apart from what is typed later
    t.engine.stopCapturing();
  });
  afterEach(() => t.destroy());

  const editor = (): HTMLTextAreaElement =>
    t.container.querySelector('textarea') as HTMLTextAreaElement;

  describe('edit state', () => {
    it('when no text is edited then there is nothing to insert into and no hold', () => {
      expect(t.engine.insertIntoEditedText('🎉'), 'insert').toBe(false);
      expect(t.engine.holdTextEdit(), 'hold').toBeUndefined();
      expect(t.engine.textEditAnchor, 'anchor').toBeNull();
    });

    it('when a text is edited then the anchor is the block on screen and it follows the camera', () => {
      const anchors: SelectionAnchor[] = [];
      t.engine.textEditAnchorChanged.on((a) => anchors.push(a));

      t.engine.startTextEdit(id);
      t.engine.flush();
      t.engine.setCamera({ x: 10, y: 20, zoom: 2 });
      t.engine.flush();
      editor().blur();
      t.engine.flush();

      expect(anchors, 'anchors').toEqual([
        { x: 100, y: 50, w: 200, h: 200 },
        { x: 210, y: 120, w: 400, h: 400 },
        null,
      ]);
    });
  });

  describe('insert', () => {
    it('when an emoji is inserted then it lands at the caret, the focus stays in the text', () => {
      t.engine.startTextEdit(id);
      editor().setSelectionRange(5, 5);

      const inserted = t.engine.insertIntoEditedText('🎉');

      expect(inserted, 'result').toBe(true);
      expect(t.board.textOf(id), 'text').toBe('hello🎉');
      expect(editor().value, 'editor').toBe('hello🎉');
      expect(document.activeElement, 'focus').toBe(editor());
    });

    it('when an inserted emoji is undone then the text is as before', () => {
      t.engine.startTextEdit(id);
      t.engine.insertIntoEditedText('🎉');
      t.engine.flush();
      editor().blur();

      t.engine.undo();

      expect(t.board.textOf(id), 'text').toBe('hello');
    });

    it('when the editor is held then focus elsewhere keeps it open until release', () => {
      t.engine.startTextEdit(id);
      const release = t.engine.holdTextEdit() as () => void;
      const search = document.createElement('input');
      document.body.appendChild(search);

      search.focus();
      expect(editor(), 'editor while held').not.toBeNull();
      t.engine.insertIntoEditedText('🎉');
      release();

      expect(document.activeElement, 'focus back in the text').toBe(editor());
      expect(t.board.textOf(id), 'text').toBe('hello🎉');
      search.remove();
    });
  });
});
