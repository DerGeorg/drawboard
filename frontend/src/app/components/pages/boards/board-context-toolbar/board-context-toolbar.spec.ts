import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BoardEngine } from '../../../../../board-engine/engine';
import { BoardDoc, createTable, tableOf } from '@apps/drawboard-engine';
import { pointerInfo } from '../../../../../board-engine/input/events';
import { Theme } from '../../../../services/theme';
import { all, buttonByLabel } from '../../../../test/dom';
import { BoardContextToolbar } from './board-context-toolbar';

describe('BoardContextToolbar', () => {
  let fixture: ComponentFixture<BoardContextToolbar>;
  let engine: BoardEngine;
  let board: BoardDoc;
  let container: HTMLElement;
  const engineSignal = signal<BoardEngine | undefined>(undefined);

  async function render(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    engineSignal.set(engine);
    fixture = TestBed.createComponent(BoardContextToolbar, {
      bindings: [inputBinding('engine', engineSignal)],
    });
    await fixture.whenStable();
  }

  /** Selects the item and lets the engine report where it is. */
  async function select(...ids: string[]): Promise<void> {
    engine.selection.set(ids);
    engine.flush();
    await fixture.whenStable();
  }

  const bar = (): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-testid=context-toolbar]');
  const addSticky = (x = 100, y = 300): string =>
    board.addBlock({ type: 'core.sticky', x, y, w: 200, h: 200, props: { color: '#fde68a' } });
  const addShape = (): string =>
    board.addBlock({
      type: 'core.shape',
      x: 100,
      y: 300,
      w: 100,
      h: 100,
      props: { kind: 'rect', fill: '#ffffff', stroke: '#0f172a', strokeWidth: 2 },
    });

  const textFill = (): boolean => all(fixture, 'button[aria-label="Fill"]').length === 1;

  afterEach(() => {
    engine.destroy();
    board.destroy();
    container.remove();
    window.localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  describe('visibility', () => {
    it('when nothing is selected then there is no toolbar', async () => {
      await render();

      expect(bar(), 'toolbar').toBeNull();
    });

    it('when something is selected then the toolbar floats above it and follows panning and zooming', async () => {
      await render();
      const id = addSticky(100, 300);

      await select(id);
      const top = (): number => Number.parseFloat(bar()?.style.top ?? 'NaN');
      expect(top(), 'above the note at y 300').toBeLessThan(300);

      engine.setCamera({ x: 0, y: 100, zoom: 1 });
      engine.flush();
      await fixture.whenStable();
      expect(top(), 'moved down with the note').toBe(300 + 100 - 12 - 48);

      engine.setCamera({ x: 0, y: 100, zoom: 2 });
      engine.flush();
      await fixture.whenStable();
      expect(top(), 'zoom moves the note and the bar with it').toBe(300 * 2 + 100 - 12 - 48);
    });

    it('when the selection is cleared then the toolbar goes away', async () => {
      await render();
      await select(addSticky());

      await select();

      expect(bar(), 'toolbar').toBeNull();
    });

    it('when the selection is being dragged then the toolbar hides and returns after the drop', async () => {
      await render();
      const id = addSticky(100, 300);
      await select(id);

      engine.pointerDown(pointerInfo({ screen: { x: 150, y: 350 }, world: { x: 150, y: 350 } }));
      engine.pointerMove(pointerInfo({ screen: { x: 190, y: 350 }, world: { x: 190, y: 350 } }));
      engine.flush();
      await fixture.whenStable();
      expect(bar(), 'hidden while dragging').toBeNull();

      engine.pointerUp(
        pointerInfo({ screen: { x: 190, y: 350 }, world: { x: 190, y: 350 }, buttons: 0 }),
      );
      engine.flush();
      await fixture.whenStable();
      expect(bar(), 'back after the drop').not.toBeNull();
    });

    it('when the board is read only then there is no toolbar', async () => {
      await render();
      const id = addSticky();
      engine.setReadOnly(true);

      await select(id);

      expect(bar(), 'toolbar').toBeNull();
    });
  });

  describe('colours from other people', () => {
    it.each(['url(https://x/y.png)', 'red; background: url(x)'])(
      'when a block carries the colour %s then the swatch shows the transparent pattern and no style reaches the browser',
      async (payload) => {
        await render();
        const id = board.addBlock({
          type: 'core.sticky',
          x: 100,
          y: 300,
          w: 200,
          h: 200,
          props: { color: payload },
        });

        await select(id);

        const html = (fixture.nativeElement as HTMLElement).innerHTML;
        expect(html, 'url in a style').not.toContain('url(x)');
        expect(html, 'url in a style').not.toContain('attacker');
        expect(html, 'url in a style').not.toContain('y.png');
        // the DOM keeps only what it can parse of the pattern: its size, never the payload
        const swatch = buttonByLabel(fixture, 'Colour').querySelector('span') as HTMLElement;
        expect(swatch.getAttribute('style'), 'swatch style').toContain('8px 8px');
      },
    );
  });

  describe('controls', () => {
    it('when a sticky is selected then only its colour, duplicate and delete are offered', async () => {
      await render();
      await select(addSticky());

      expect(buttonByLabel(fixture, 'Colour'), 'colour').toBeDefined();
      expect(() => buttonByLabel(fixture, 'Fill'), 'fill').toThrow();
      expect(() => buttonByLabel(fixture, 'Width'), 'width').toThrow();
      expect(buttonByLabel(fixture, 'Duplicate'), 'duplicate').toBeDefined();
      expect(buttonByLabel(fixture, 'Delete'), 'delete').toBeDefined();
    });

    it('when a colour is picked then the sticky changes and the menu stays usable', async () => {
      await render();
      const id = addSticky();
      await select(id);

      buttonByLabel(fixture, 'Colour').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Colour #bae6fd').click();
      await fixture.whenStable();

      expect(board.getBlock(id)?.props['color'], 'sticky colour').toBe('#bae6fd');
      expect(
        buttonByLabel(fixture, 'Colour #bae6fd').getAttribute('aria-pressed'),
        'picked swatch is pressed',
      ).toBe('true');
    });

    it('when the theme is dark then the swatches show the drawn colours and the shape keeps its own', async () => {
      await render();
      const id = addShape();
      await TestBed.inject(Theme).set('DARK');
      await select(id);

      const swatch = (label: string): string =>
        (buttonByLabel(fixture, label).querySelector('span') as HTMLElement).style.background;
      expect(swatch('Fill'), 'white fill').toBe('rgb(30, 41, 59)');
      expect(swatch('Stroke'), 'default ink').toBe('rgb(226, 232, 240)');
      expect(board.getBlock(id)?.props, 'stored colours').toMatchObject({
        fill: '#ffffff',
        stroke: '#0f172a',
      });
    });

    it('when a shape is selected then fill, stroke and width apply to it', async () => {
      await render();
      const id = addShape();
      await select(id);

      buttonByLabel(fixture, 'Fill').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Fill #fecdd3').click();
      buttonByLabel(fixture, 'Stroke').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Stroke #dc2626').click();
      buttonByLabel(fixture, 'Width').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Width 8').click();

      expect(board.getBlock(id)?.props, 'shape props').toMatchObject({
        fill: '#fecdd3',
        stroke: '#dc2626',
        strokeWidth: 8,
      });
    });

    it('when a pen stroke is selected then stroke and width are offered but no fill', async () => {
      await render();
      const stroke = board.addStroke([0, 300, 0.5, 100, 400, 0.5], { color: '#0f172a', size: 4 });
      await select(stroke);

      buttonByLabel(fixture, 'Stroke').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Stroke #2563eb').click();

      expect(board.getStroke(stroke)?.style.color, 'stroke colour').toBe('#2563eb');
      expect(() => buttonByLabel(fixture, 'Fill'), 'no fill').toThrow();
    });

    it('when a text block is selected then its colour comes from the dark palette', async () => {
      await render();
      const id = board.addBlock({
        type: 'core.text',
        x: 100,
        y: 300,
        w: 100,
        h: 40,
        props: { color: '#0f172a', fontSize: 20 },
      });
      await select(id);

      buttonByLabel(fixture, 'Text colour').click();
      await fixture.whenStable();

      expect(buttonByLabel(fixture, 'Text colour #dc2626'), 'dark palette').toBeDefined();
      expect(() => buttonByLabel(fixture, 'Text colour #fde68a'), 'no pastel').toThrow();
    });

    it('when the same trigger is clicked twice then its menu closes', async () => {
      await render();
      await select(addSticky());

      buttonByLabel(fixture, 'Colour').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Colour').click();
      await fixture.whenStable();

      expect(all(fixture, '[role=group]').length, 'open menus').toBe(0);
    });

    it('when Escape is pressed or the selection changes then an open menu closes', async () => {
      await render();
      const a = addSticky();
      const b = addSticky(500, 300);
      await select(a);
      buttonByLabel(fixture, 'Colour').click();
      await fixture.whenStable();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      await fixture.whenStable();
      expect(all(fixture, '[role=group]').length, 'after Escape').toBe(0);

      buttonByLabel(fixture, 'Colour').click();
      await fixture.whenStable();
      await select(b);
      expect(all(fixture, '[role=group]').length, 'after selecting something else').toBe(0);
    });
  });

  describe('actions', () => {
    it('when duplicate is clicked then a copy exists and is selected', async () => {
      await render();
      await select(addSticky());

      buttonByLabel(fixture, 'Duplicate').click();

      expect(board.blockIds().length, 'blocks').toBe(2);
      expect(engine.selection.size, 'the copy is selected').toBe(1);
    });

    it('when a frame is selected then "remove frame, keep contents" removes only the frame', async () => {
      await render();
      const frame = board.addBlock({
        type: 'core.frame',
        x: 100,
        y: 300,
        w: 400,
        h: 300,
        props: { fill: '#ffffff' },
      });
      const note = board.addBlock({
        type: 'core.sticky',
        x: 150,
        y: 400,
        w: 50,
        h: 50,
        parent: frame,
      });
      await select(note);
      expect(
        all(fixture, 'button[aria-label="Remove frame, keep contents"]').length,
        'not for a note',
      ).toBe(0);
      await select(frame);

      expect(textFill(), 'fill offered for the frame').toBe(true);
      buttonByLabel(fixture, 'Remove frame, keep contents').click();

      expect(board.hasBlock(frame), 'frame gone').toBe(false);
      expect(board.getBlock(note)?.parent, 'note kept').toBeNull();
    });

    it('when a table cell is selected then rows and columns can be added and removed', async () => {
      await render();
      const table = createTable(board, { x: 600, y: 600 });
      const header = tableOf(board, table)?.cells[0]?.[1] ?? '';
      await select(header);
      const button = (label: string): HTMLButtonElement => buttonByLabel(fixture, label);

      expect(button('Remove row').disabled, 'never the header row').toBe(true);
      button('Add row').click();
      button('Add column').click();
      expect(tableOf(board, table), 'grown').toMatchObject({ rows: 4, cols: 4 });
      button('Remove column').click();
      expect(tableOf(board, table)?.cols, 'column removed').toBe(3);
      await select(tableOf(board, table)?.cells[2]?.[0] ?? '');
      button('Remove row').click();
      expect(tableOf(board, table)?.rows, 'row removed').toBe(3);
      expect(
        all(fixture, 'button[aria-label="Remove frame, keep contents"]').length,
        'not for a cell',
      ).toBe(0);
    });

    it('when delete is clicked then the selection is gone and so is the toolbar', async () => {
      await render();
      await select(addSticky());

      buttonByLabel(fixture, 'Delete').click();
      engine.flush();
      await fixture.whenStable();

      expect(board.blockIds().length, 'blocks').toBe(0);
      expect(bar(), 'toolbar').toBeNull();
    });
  });
});
