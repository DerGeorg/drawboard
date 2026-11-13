import { BlockData, Props } from '../model/types';
import { TestEngine, createTestEngine } from '../testing/helpers';
import { EMOJI_DEFAULT_SIZE, EMOJI_TYPE, MAX_EMOJI_PX, emojiBlock, emojiFontSize } from './emoji';

describe('emojiBlock', () => {
  const anEmoji = (props: Props, w = 64, h = 64): BlockData => ({
    id: 'e1',
    type: EMOJI_TYPE,
    x: 0,
    y: 0,
    w,
    h,
    rotation: 0,
    z: 1,
    parent: null,
    locked: false,
    props,
    hasText: false,
  });

  function render(block: BlockData): { host: HTMLElement; update: (b: BlockData) => void } {
    const host = document.createElement('div');
    const view = emojiBlock.render(host, { block, text: () => '', readOnly: false });
    return { host, update: view.update };
  }

  describe('render', () => {
    it('when the block holds an emoji then it is drawn as text', () => {
      const { host } = render(anEmoji({ emoji: '🎉' }));

      expect(host.textContent, 'text').toBe('🎉');
      expect(host.querySelectorAll('*').length, 'no elements beyond the glyph box').toBe(1);
    });

    it('when the block is resized then the font size follows the smaller side', () => {
      const { host, update } = render(anEmoji({ emoji: '🎉' }));
      const glyph = host.firstElementChild as HTMLElement;
      expect(glyph.style.fontSize, 'at 64x64').toBe(`${emojiFontSize(64, 64)}px`);

      update(anEmoji({ emoji: '🎉' }, 200, 100));

      expect(glyph.style.fontSize, 'at 200x100').toBe(`${emojiFontSize(100, 100)}px`);
      expect(emojiFontSize(200, 100), 'by the smaller side').toBe(emojiFontSize(100, 200));
    });

    it('when the block is huge then the font size is capped, and the element isolates bidi', () => {
      const { host } = render(anEmoji({ emoji: '🎉' }, 1e9, 1e9));
      const glyph = host.firstElementChild as HTMLElement;

      expect(emojiFontSize(1e9, 1e9), 'size').toBe(MAX_EMOJI_PX * 0.78);
      expect(glyph.style.fontSize, 'style').toBe(`${MAX_EMOJI_PX * 0.78}px`);
      expect(glyph.style.unicodeBidi, 'bidi').toBe('isolate');
    });

    it('when the prop is markup then it never becomes elements and the fallback shows', () => {
      const { host } = render(anEmoji({ emoji: '<img src=x onerror=alert(1)>' }));

      expect(host.querySelector('img'), 'img').toBeNull();
      expect(host.textContent, 'text').toBe('❔');
    });

    it('when the prop is missing or not a string then the fallback shows', () => {
      expect(render(anEmoji({})).host.textContent, 'missing').toBe('❔');
      expect(render(anEmoji({ emoji: 5 })).host.textContent, 'number').toBe('❔');
    });

    it('when the prop changes then the glyph changes', () => {
      const { host, update } = render(anEmoji({ emoji: '🎉' }));

      update(anEmoji({ emoji: '🚀' }));

      expect(host.textContent, 'text').toBe('🚀');
    });

    it('when far zoomed out then the block has a plain fill', () => {
      expect(emojiBlock.simpleFill?.(anEmoji({ emoji: '🎉' })), 'fill').toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  describe('registration', () => {
    it('when the engine registers the built-ins then the emoji block is trusted and 64 x 64', () => {
      const t: TestEngine = createTestEngine();
      const type = t.engine.registry.get(EMOJI_TYPE);

      expect(type?.trusted, 'trusted').toBe(true);
      expect(type?.defaultSize, 'size').toEqual({ w: EMOJI_DEFAULT_SIZE, h: EMOJI_DEFAULT_SIZE });
      t.destroy();
    });
  });
});
