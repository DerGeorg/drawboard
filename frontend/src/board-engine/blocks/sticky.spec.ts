import { BlockData, STICKY_COLORS } from '@apps/drawboard-engine';
import { STICKY_FONT_MAX, STICKY_FONT_MIN, stickyBlock } from './sticky';

describe('stickyBlock', () => {
  const aSticky = (color: unknown): BlockData => ({
    id: 'b1',
    type: 'core.sticky',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    rotation: 0,
    z: 1,
    parent: null,
    locked: false,
    props: { color },
    hasText: true,
  });

  function render(color: unknown): { note: HTMLElement; update: (c: unknown) => void } {
    const host = document.createElement('div');
    const view = stickyBlock.render(host, {
      block: aSticky(color),
      text: () => '',
      readOnly: false,
      theme: () => 'light',
    });
    return {
      note: host.querySelector<HTMLElement>('.be-sticky') as HTMLElement,
      update: (c) => view.update(aSticky(c)),
    };
  }

  describe('color', () => {
    it('when the color is a hex color then it is the background', () => {
      const { note } = render('#bae6fd');

      expect(note.style.background, 'background').toContain('rgb(186, 230, 253)');
    });

    it('when a remote editor sets a url() as color then the default color is used instead', () => {
      const { note, update } = render('url(https://attacker.example/pixel.png)');

      expect(note.style.background, 'on create').not.toContain('url');
      update('url(https://attacker.example/pixel.png)');
      expect(note.style.background, 'on update').not.toContain('url');
      expect(STICKY_COLORS[0], 'fallback').toBe('#fde68a');
    });
  });

  describe('auto-fit', () => {
    const block: BlockData = {
      id: 'b1',
      type: 'core.sticky',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      rotation: 0,
      z: 1,
      parent: null,
      locked: false,
      props: { color: '#fde68a' },
      hasText: true,
    };

    afterEach(() => vi.restoreAllMocks());

    /** jsdom has no layout: the text is `lines` lines of 1.35 x font size inside a 200 px note. */
    function withLayout(lines: number): void {
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
      vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200);
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
        this: HTMLElement,
      ) {
        return parseFloat(this.style.fontSize || '0') * 1.35 * lines + 24;
      });
    }

    function render(): { host: HTMLElement; note: HTMLElement; mounted: () => void } {
      const host = document.createElement('div');
      const view = stickyBlock.render(host, {
        block,
        text: () => 'text',
        readOnly: false,
        theme: () => 'light',
      });
      return {
        host,
        note: host.querySelector<HTMLElement>('.be-sticky') as HTMLElement,
        mounted: () => view.mounted?.(),
      };
    }

    it('when the text is short then it keeps the large size', () => {
      withLayout(1);

      expect(render().note.style.fontSize, 'font size').toBe(`${STICKY_FONT_MAX}px`);
    });

    it('when the text is long then the font size steps down until it fits', () => {
      withLayout(9);

      const { note } = render();
      const size = parseFloat(note.style.fontSize);

      expect(size, 'smaller than the maximum').toBeLessThan(STICKY_FONT_MAX);
      expect(size * 1.35 * 9 + 24, 'content fits the 200 px note').toBeLessThanOrEqual(200);
      expect((size + 2) * 1.35 * 9 + 24, 'one step larger would not fit').toBeGreaterThan(200);
    });

    it('when the text can never fit then the font size stops at the minimum', () => {
      withLayout(200);

      expect(render().note.style.fontSize, 'font size').toBe(`${STICKY_FONT_MIN}px`);
    });

    it('when the note is mounted into the document then it is fitted again', () => {
      withLayout(9);
      const { note, mounted } = render();
      note.style.fontSize = '99px';

      mounted();

      expect(note.style.fontSize, 'refitted').not.toBe('99px');
    });

    it('when fitted then the text editor learns the size through a CSS variable', () => {
      withLayout(1);

      const { host } = render();

      expect(host.style.getPropertyValue('--be-font-size'), 'variable').toBe(
        `${STICKY_FONT_MAX}px`,
      );
    });
  });
});
