import { BoardEngine } from '../engine';
import { BoardDoc, BoardTheme, MAX_MERMAID_BYTES, MERMAID_TYPE } from '@apps/drawboard-engine';
import { DiagramRenderer, RENDER_DELAY_MS } from './mermaid';

describe('mermaid block', () => {
  let container: HTMLElement;
  let board: BoardDoc;
  let engine: BoardEngine;
  let rendered: string[];

  const svgOf = (source: string): Node => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-source', source);
    return svg;
  };
  const okRenderer: DiagramRenderer = {
    render: (source) => {
      rendered.push(source);
      return Promise.resolve(svgOf(source));
    },
  };

  function setUp(renderer: DiagramRenderer | null = okRenderer, readOnly = false): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board, {
      readOnly,
      services: { diagrams: renderer ?? undefined },
    });
  }

  const add = (text: string): string =>
    board.addBlock({ type: MERMAID_TYPE, x: 0, y: 0, w: 400, h: 200, text });
  const view = (): HTMLElement | null => container.querySelector('.be-mermaid');
  /** The diagram lives in a shadow root (review finding 5). */
  const svg = (): SVGElement | null =>
    container.querySelector('.be-mermaid-diagram')?.shadowRoot?.querySelector('svg') ?? null;

  beforeEach(() => {
    rendered = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    engine.destroy();
    board.destroy();
    container.remove();
    vi.useRealTimers();
  });

  describe('rendering', () => {
    it('when a diagram is added then it renders asynchronously and shows the result', async () => {
      setUp();
      add('flowchart LR\n A --> B');

      expect(view()?.textContent, 'not inside the transaction').toContain('Rendering');
      await vi.advanceTimersByTimeAsync(0);

      expect(rendered, 'rendered').toEqual(['flowchart LR\n A --> B']);
      expect(svg(), 'svg shown').not.toBeNull();
      expect(view()?.querySelector('svg'), 'inside a shadow root, not in the page').toBeNull();
    });

    it('when the source is typed then only the last state renders after a pause', async () => {
      setUp();
      const id = add('flowchart LR');
      await vi.advanceTimersByTimeAsync(0);

      engine.setBlockText(id, 'flowchart LR\n A');
      engine.setBlockText(id, 'flowchart LR\n A --> B');
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

      expect(rendered, 'debounced').toEqual(['flowchart LR', 'flowchart LR\n A --> B']);
    });

    it('when the theme changes then the same source renders again in the theme, without a document change', async () => {
      const themes: (BoardTheme | undefined)[] = [];
      setUp({
        render: (source, theme) => {
          rendered.push(source);
          themes.push(theme);
          return Promise.resolve(svgOf(source));
        },
      });
      add('flowchart LR\n A --> B');
      await vi.advanceTimersByTimeAsync(0);
      const changes: unknown[] = [];
      board.observe((change) => changes.push(change));

      engine.setTheme('dark');
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

      expect(themes, 'themes of the renders').toEqual(['light', 'dark']);
      expect(rendered.length, 'rendered twice').toBe(2);
      expect(svg(), 'diagram shown').not.toBeNull();
      expect(changes, 'document changes').toEqual([]);
    });

    it('when the theme is set again to the same one then the diagram is not rendered again', async () => {
      setUp();
      add('flowchart LR');
      await vi.advanceTimersByTimeAsync(0);

      engine.setTheme('light');
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

      expect(rendered, 'renders').toEqual(['flowchart LR']);
    });

    it('when the renderer fails then the error is shown as text', async () => {
      setUp({ render: () => Promise.reject(new Error('Parse error on line 2: <b>x</b>')) });
      add('flowchart ??');
      await vi.advanceTimersByTimeAsync(0);

      const error = view()?.querySelector('.be-mermaid-error');
      expect(error?.textContent, 'message as text').toBe(
        'Diagram error: Parse error on line 2: <b>x</b>',
      );
      expect(view()?.querySelector('b'), 'no markup from the message').toBeNull();
    });

    it('when the source is larger than 50 KB then it is not rendered', async () => {
      setUp();
      add(`flowchart LR\n${'A-->B\n'.repeat(MAX_MERMAID_BYTES / 6 + 1)}`);
      await vi.advanceTimersByTimeAsync(0);

      expect(rendered, 'nothing rendered').toEqual([]);
      expect(view()?.textContent, 'message').toContain('larger than 50 KB');
    });

    it('when there is no renderer then the source is shown as text', () => {
      setUp(null);
      add('graph TD; A-->B');

      expect(view()?.querySelector('pre')?.textContent, 'source').toBe('graph TD; A-->B');
    });

    it('when the diagram is empty then the block says how to write it', () => {
      setUp();
      add('');

      expect(view()?.textContent, 'hint').toContain('Double-click');
    });

    it('when a slow render finishes after a newer one then the newer one stays', async () => {
      let first: (n: Node) => void = () => undefined;
      let calls = 0;
      setUp({
        render: (source) => {
          calls++;
          return calls === 1
            ? new Promise((resolve) => (first = resolve))
            : Promise.resolve(svgOf(source));
        },
      });
      const id = add('old');
      await vi.advanceTimersByTimeAsync(0);
      engine.setBlockText(id, 'new');
      await vi.advanceTimersByTimeAsync(RENDER_DELAY_MS);

      first(svgOf('old'));
      await vi.advanceTimersByTimeAsync(0);

      expect(svg()?.getAttribute('data-source'), 'newest').toBe('new');
    });
  });

  describe('editing', () => {
    it('when a diagram is double-clicked then the engine asks the host to open its editor', () => {
      setUp();
      const id = add('graph TD; A-->B');
      const opened: string[] = [];
      engine.blockOpened.on((b) => opened.push(b));

      engine.doubleClick({
        screen: { x: 10, y: 10 },
        world: { x: 10, y: 10 },
        buttons: 1,
        shift: false,
        alt: false,
        mod: false,
        pointerId: 1,
        pressure: 0.5,
        detail: 2,
        touch: false,
      });

      expect(opened, 'opened').toEqual([id]);
      expect(engine.selection.list(), 'selected').toEqual([id]);
    });

    it('when the source is set from outside then it is one Y.Text edit and undoable', () => {
      setUp();
      const id = add('graph TD; A-->B');
      engine.stopCapturing();

      expect(engine.setBlockText(id, 'graph TD; A-->C'), 'written').toBe(true);
      expect(board.textOf(id), 'text').toBe('graph TD; A-->C');
      engine.undo();
      expect(board.textOf(id), 'undone').toBe('graph TD; A-->B');
    });

    it('when the board is read-only then the editor is not opened and nothing is written', () => {
      setUp(okRenderer, true);
      const id = add('graph TD; A-->B');
      const opened: string[] = [];
      engine.blockOpened.on((b) => opened.push(b));

      engine.openBlock(id);

      expect(opened, 'not opened').toEqual([]);
      expect(engine.setBlockText(id, 'x'), 'refused').toBe(false);
    });
  });
});
