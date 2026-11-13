import { EMOJI_TYPE } from '../blocks/emoji';
import { TestEngine, createTestEngine } from '../testing/helpers';

describe('emoji stamp tool', () => {
  let t: TestEngine;
  beforeEach(() => {
    t = createTestEngine();
    t.engine.setDrawStyle({ emoji: '🎉' });
    t.engine.setTool('emoji');
  });
  afterEach(() => t.destroy());

  describe('placing', () => {
    it('when clicking then the chosen emoji is placed centred on the pointer at 64 x 64', () => {
      t.click(200, 100);

      expect(t.board.blocks(), 'blocks').toMatchObject([
        { type: EMOJI_TYPE, x: 168, y: 68, w: 64, h: 64, props: { emoji: '🎉' } },
      ]);
    });

    it('when clicking again then every click stamps and the tool stays active', () => {
      t.click(0, 0);
      t.click(100, 0);
      t.click(200, 0);

      expect(t.board.blockIds().length, 'blocks').toBe(3);
      expect(t.engine.tool, 'tool').toBe('emoji');
    });

    it('when the emoji is changed then the next stamps use it', () => {
      t.click(0, 0);
      t.engine.setDrawStyle({ emoji: '🚀' });

      t.click(100, 0);

      expect(
        t.board.blocks().map((b) => b.props['emoji']),
        'emojis',
      ).toEqual(['🎉', '🚀']);
    });

    it('when the pointer is dragged then nothing is stamped', () => {
      t.drag({ x: 0, y: 0 }, { x: 80, y: 80 });

      expect(t.board.blockIds().length, 'blocks').toBe(0);
    });
  });

  describe('leaving', () => {
    it('when Escape is pressed then the select tool is active and clicks stamp nothing', () => {
      t.click(0, 0);

      t.key('Escape');
      t.click(100, 100);

      expect(t.engine.tool, 'tool').toBe('select');
      expect(t.board.blockIds().length, 'blocks').toBe(1);
    });

    it('when another tool is chosen then the stamp stops', () => {
      t.engine.setTool('rect');

      t.click(0, 0);

      expect(
        t.board.blocks().map((b) => b.type),
        'types',
      ).not.toContain(EMOJI_TYPE);
    });
  });

  describe('history and limits', () => {
    it('when a stamp is undone then it is gone, one step per stamp', () => {
      t.click(0, 0);
      t.click(100, 0);

      t.engine.undo();

      expect(t.board.blocks().length, 'blocks').toBe(1);
    });

    it('when the chosen emoji is not an emoji then nothing is stamped', () => {
      t.engine.setDrawStyle({ emoji: '<b>' });

      t.click(0, 0);

      expect(t.board.blockIds().length, 'blocks').toBe(0);
    });

    it('when the board is read-only then the stamp tool is not available', () => {
      const other = createTestEngine({ readOnly: true });
      other.engine.setTool('emoji');

      other.click(0, 0);

      expect(other.engine.tool, 'tool').toBe('select');
      expect(other.board.blockIds().length, 'blocks').toBe(0);
      other.destroy();
    });
  });
});
