import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BoardEngine } from '../../../../../board-engine/engine';
import { BoardDoc } from '../../../../../board-engine/model/board-doc';
import { all, buttonByLabel } from '../../../../test/dom';
import type { PluginBlockOption } from '../../../../../board-engine/plugins/plugin-host';
import { EmojiCatalog, RawEmoji } from '../../../shared/emoji-picker/emoji-catalog';
import { BoardToolbar } from './board-toolbar';

describe('BoardToolbar', () => {
  let fixture: ComponentFixture<BoardToolbar>;
  let engine: BoardEngine;
  let board: BoardDoc;
  let container: HTMLElement;
  const readOnly = signal(false);
  const canUpload = signal(false);
  let uploaded: File[][];
  let diagrams: number;
  let kanbans: number;
  let stories: number;
  const pluginBlocks = signal<PluginBlockOption[]>([]);
  let picked: PluginBlockOption[];

  async function render(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    fixture = TestBed.createComponent(BoardToolbar, {
      bindings: [
        inputBinding('engine', () => engine),
        inputBinding('readOnly', readOnly),
        inputBinding('canUpload', canUpload),
        outputBinding<File[]>('upload', (files) => uploaded.push(files)),
        outputBinding('diagram', () => diagrams++),
        outputBinding('kanban', () => kanbans++),
        outputBinding('story', () => stories++),
        inputBinding('pluginBlocks', pluginBlocks),
        outputBinding<PluginBlockOption>('pluginBlock', (o) => picked.push(o)),
      ],
    });
    await fixture.whenStable();
  }

  const pressed = (label: string): string | null =>
    buttonByLabel(fixture, label).getAttribute('aria-pressed');
  const flyout = (): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-testid=flyout]');

  beforeEach(() => {
    readOnly.set(false);
    canUpload.set(false);
    uploaded = [];
    diagrams = 0;
    kanbans = 0;
    stories = 0;
    picked = [];
    pluginBlocks.set([]);
  });
  afterEach(() => {
    engine.destroy();
    board.destroy();
    container.remove();
  });

  describe('tools', () => {
    it('when a tool button is clicked then the engine switches and the button shows it as pressed', async () => {
      await render();

      buttonByLabel(fixture, 'Text').click();
      await fixture.whenStable();

      expect(engine.tool, 'engine tool').toBe('text');
      expect(pressed('Text'), 'pressed').toBe('true');
      expect(pressed('Select'), 'select not pressed').toBe('false');
    });

    it('when the frame button is clicked then the frame tool is active', async () => {
      await render();

      buttonByLabel(fixture, 'Frame').click();
      await fixture.whenStable();

      expect(engine.tool, 'engine tool').toBe('frame');
      expect(pressed('Frame'), 'pressed').toBe('true');
    });

    it('when the tool changes through a shortcut then the toolbar follows', async () => {
      await render();

      engine.setTool('hand');
      await fixture.whenStable();

      expect(pressed('Hand'), 'pressed').toBe('true');
    });

    it('when a shape shortcut is used then the shapes button is pressed and stands for that shape', async () => {
      await render();

      engine.setTool('diamond');
      await fixture.whenStable();
      engine.setTool('select');
      await fixture.whenStable();
      buttonByLabel(fixture, 'Shapes').click();
      await fixture.whenStable();

      expect(engine.tool, 'the last shape is picked again').toBe('diamond');
    });

    it('when the focus is on a tool then the arrow keys move it to the next and previous tool', async () => {
      await render();
      const select = buttonByLabel(fixture, 'Select');
      select.focus();

      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

      expect(document.activeElement, 'next tool').toBe(buttonByLabel(fixture, 'Hand'));
      buttonByLabel(fixture, 'Hand').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
      expect(document.activeElement, 'back to select').toBe(select);
    });

    it('when a tool button is hovered then the tooltip names it with its shortcut', async () => {
      await render();

      const tips = all(fixture, '.tooltip').map((t) => t.getAttribute('data-tip'));

      expect(tips, 'tooltips').toContain('Sticky note (S)');
      expect(tips, 'tooltips').toContain('Undo (Ctrl+Z)');
    });
  });

  describe('flyouts', () => {
    it('when the sticky tool is chosen then its colours open and a colour sets the next sticky', async () => {
      await render();

      buttonByLabel(fixture, 'Sticky note').click();
      await fixture.whenStable();
      expect(flyout(), 'flyout').not.toBeNull();
      buttonByLabel(fixture, 'Sticky colour #bae6fd').click();
      await fixture.whenStable();

      expect(engine.drawStyle.sticky, 'draw style').toBe('#bae6fd');
      expect(pressed('Sticky colour #bae6fd'), 'swatch pressed').toBe('true');
    });

    it('when the sticky button is clicked again then the flyout closes', async () => {
      await render();

      buttonByLabel(fixture, 'Sticky note').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Sticky note').click();
      await fixture.whenStable();

      expect(flyout(), 'flyout').toBeNull();
      expect(engine.tool, 'tool stays').toBe('sticky');
    });

    it('when a shape is picked in the shapes flyout then that tool is active and the flyout closes', async () => {
      await render();

      buttonByLabel(fixture, 'Shapes').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Ellipse').click();
      await fixture.whenStable();

      expect(engine.tool, 'tool').toBe('ellipse');
      expect(flyout(), 'flyout').toBeNull();
      expect(pressed('Shapes'), 'group pressed').toBe('true');
    });

    it('when the pen is chosen then colour and width change what it draws with', async () => {
      await render();

      buttonByLabel(fixture, 'Pen').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Pen colour #dc2626').click();
      buttonByLabel(fixture, 'Pen width 8').click();
      await fixture.whenStable();

      expect(engine.drawStyle.color, 'colour').toBe('#dc2626');
      expect(engine.drawStyle.size, 'size').toBe(8);
    });

    it('when the shapes flyout is open then fill and outline set the style of the next shape', async () => {
      await render();

      buttonByLabel(fixture, 'Shapes').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Fill #bae6fd').click();
      buttonByLabel(fixture, 'Outline #16a34a').click();
      await fixture.whenStable();

      expect(engine.drawStyle.fill, 'fill').toBe('#bae6fd');
      expect(engine.drawStyle.color, 'outline').toBe('#16a34a');
      expect(pressed('Fill #bae6fd'), 'swatch pressed').toBe('true');
    });

    it('when the connector is chosen then its colour can be changed', async () => {
      await render();

      buttonByLabel(fixture, 'Connector').click();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Connector colour #2563eb').click();

      expect(engine.drawStyle.color, 'colour').toBe('#2563eb');
    });

    it('when another tool is chosen then the open flyout goes away', async () => {
      await render();
      buttonByLabel(fixture, 'Pen').click();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Hand').click();
      await fixture.whenStable();

      expect(flyout(), 'flyout').toBeNull();
    });

    it('when Escape is pressed or the pointer goes down elsewhere then the flyout closes', async () => {
      await render();
      buttonByLabel(fixture, 'Pen').click();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Pen').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await fixture.whenStable();
      expect(flyout(), 'after Escape').toBeNull();

      buttonByLabel(fixture, 'Pen').click();
      await fixture.whenStable();
      expect(flyout(), 'reopened').not.toBeNull();
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await fixture.whenStable();
      expect(flyout(), 'after outside click').toBeNull();
    });
  });

  describe('plugins', () => {
    const counter: PluginBlockOption = {
      pluginId: 'org.example.counter',
      type: 'org.example.counter.counter',
      label: 'Counter',
      w: 200,
      h: 100,
    };

    it('when no plugin is enabled then there is no plugin button', async () => {
      await render();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('button[aria-label="Plugin blocks"]'),
        'none',
      ).toBeNull();
    });

    it('when a plugin block type is picked from the menu then the page is asked to add it', async () => {
      pluginBlocks.set([counter]);
      await render();

      buttonByLabel(fixture, 'Plugin blocks').click();
      await fixture.whenStable();
      const item = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '[data-testid=plugin-menu] button',
      );
      expect(item?.textContent, 'label and plugin').toContain('Counter');
      item?.click();
      await fixture.whenStable();

      expect(picked, 'picked').toEqual([counter]);
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid=plugin-menu]'),
        'menu closed',
      ).toBeNull();
    });

    it('when the menu is open and someone clicks elsewhere then it closes', async () => {
      pluginBlocks.set([counter]);
      await render();
      buttonByLabel(fixture, 'Plugin blocks').click();
      await fixture.whenStable();

      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await fixture.whenStable();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid=plugin-menu]'),
        'closed',
      ).toBeNull();
    });
  });

  describe('kanban', () => {
    it('when the kanban button is clicked then the page is asked for a new kanban', async () => {
      await render();

      buttonByLabel(fixture, 'Kanban').click();
      buttonByLabel(fixture, 'Story card').click();

      expect(kanbans, 'kanban asked').toBe(1);
      expect(stories, 'story asked').toBe(1);
    });

    it('when the board is read-only then there is no kanban button', async () => {
      readOnly.set(true);
      await render();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('button[aria-label="Kanban"]'),
        'no button',
      ).toBeNull();
    });
  });

  describe('diagram', () => {
    it('when the diagram button is clicked then the page is asked for a new diagram', async () => {
      await render();

      buttonByLabel(fixture, 'Diagram').click();

      expect(diagrams, 'asked').toBe(1);
    });

    it('when the board is read-only then there is no diagram button', async () => {
      readOnly.set(true);
      await render();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('button[aria-label="Diagram"]'),
        'none',
      ).toBeNull();
    });
  });

  describe('upload', () => {
    it('when uploading is not allowed then there is no upload button', async () => {
      await render();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('button[aria-label="Upload files"]'),
        'button',
      ).toBeNull();
    });

    it('when files are picked then they go out and the picker is reset', async () => {
      canUpload.set(true);
      await render();
      const picker = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        '[data-testid=file-picker]',
      ) as HTMLInputElement;
      const click = vi.spyOn(picker, 'click').mockImplementation(() => undefined);
      const file = new File(['x'], 'a.png');
      Object.defineProperty(picker, 'files', { value: [file], configurable: true });

      buttonByLabel(fixture, 'Upload files').click();
      picker.dispatchEvent(new Event('change'));

      expect(click, 'file dialog opened').toHaveBeenCalled();
      expect(uploaded, 'files').toEqual([[file]]);
      expect(picker.accept, 'only accepted types').toContain('.pdf');
      Object.defineProperty(picker, 'files', { value: [], configurable: true });
      picker.dispatchEvent(new Event('change'));
      expect(uploaded.length, 'nothing picked: nothing sent').toBe(1);
    });
  });

  describe('history', () => {
    it('when something was drawn then undo is enabled until it is clicked, then redo is', async () => {
      await render();
      expect(buttonByLabel(fixture, 'Undo').disabled, 'undo before').toBe(true);

      board.addBlock({ type: 'core.sticky', x: 0, y: 0, w: 10, h: 10 });
      await fixture.whenStable();
      expect(buttonByLabel(fixture, 'Undo').disabled, 'undo after drawing').toBe(false);

      buttonByLabel(fixture, 'Undo').click();
      await fixture.whenStable();

      expect(board.blockIds().length, 'blocks').toBe(0);
      expect(buttonByLabel(fixture, 'Redo').disabled, 'redo').toBe(false);
      buttonByLabel(fixture, 'Redo').click();
      expect(board.blockIds().length, 'blocks after redo').toBe(1);
    });
  });

  describe('emoji stamp', () => {
    const RAW: RawEmoji[] = [
      { unicode: '🎉', label: 'party popper', group: 0, tags: ['party'] },
      { unicode: '🚀', label: 'rocket', group: 0, tags: ['space'] },
    ];
    beforeEach(() => {
      localStorage.clear();
      TestBed.inject(EmojiCatalog).loadRaw = async () => RAW;
    });

    it('when the stamp button is clicked then the stamp tool is active and the picker opens', async () => {
      await render();

      buttonByLabel(fixture, 'Emoji stamp').click();
      await fixture.whenStable();

      expect(engine.tool, 'engine tool').toBe('emoji');
      expect(flyout()?.querySelector('[data-testid=emoji-picker]'), 'picker').not.toBeNull();
      expect(
        all(fixture, '.tooltip').map((t) => t.getAttribute('data-tip')),
        'tooltip without a shortcut',
      ).toContain('Emoji stamp');
    });

    it('when an emoji is picked then it is the stamp, the picker closes and the tool stays', async () => {
      await render();
      buttonByLabel(fixture, 'Emoji stamp').click();
      await fixture.whenStable();

      buttonByLabel(fixture, 'rocket').click();
      await fixture.whenStable();

      expect(engine.drawStyle.emoji, 'stamp').toBe('🚀');
      expect(engine.tool, 'engine tool').toBe('emoji');
      expect(flyout(), 'flyout').toBeNull();
      expect(pressed('Emoji stamp'), 'pressed').toBe('true');
    });

    it('when another tool is chosen then the picker closes', async () => {
      await render();
      buttonByLabel(fixture, 'Emoji stamp').click();
      await fixture.whenStable();

      engine.setTool('select');
      await fixture.whenStable();

      expect(flyout(), 'flyout').toBeNull();
      expect(pressed('Emoji stamp'), 'pressed').toBe('false');
    });

    it('when Escape is pressed in the picker then the picker closes and the tool stays', async () => {
      await render();
      buttonByLabel(fixture, 'Emoji stamp').click();
      await fixture.whenStable();

      (fixture.nativeElement as HTMLElement)
        .querySelector('input[type=search]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await fixture.whenStable();

      expect(flyout(), 'flyout').toBeNull();
      expect(engine.tool, 'engine tool').toBe('emoji');
    });
  });

  describe('read-only', () => {
    it('when the board is read-only then only select and hand remain', async () => {
      readOnly.set(true);
      await render();

      expect(() => buttonByLabel(fixture, 'Sticky note'), 'sticky').toThrow();
      expect(() => buttonByLabel(fixture, 'Emoji stamp'), 'emoji stamp').toThrow();
      expect(() => buttonByLabel(fixture, 'Undo'), 'undo').toThrow();
      expect(buttonByLabel(fixture, 'Hand'), 'hand').toBeDefined();
    });
  });
});
