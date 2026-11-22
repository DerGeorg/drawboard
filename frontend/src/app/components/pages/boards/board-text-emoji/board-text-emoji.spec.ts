import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BoardEngine } from '../../../../../board-engine/engine';
import { BoardDoc } from '@apps/drawboard-engine';
import { all, buttonByLabel } from '../../../../test/dom';
import { EmojiCatalog, RawEmoji } from '../../../shared/emoji-picker/emoji-catalog';
import { BoardTextEmoji } from './board-text-emoji';

const RAW: RawEmoji[] = [
  { unicode: '🎉', label: 'party popper', group: 0, tags: ['party'] },
  { unicode: '🚀', label: 'rocket', group: 0, tags: ['space'] },
];

describe('BoardTextEmoji', () => {
  let fixture: ComponentFixture<BoardTextEmoji>;
  let engine: BoardEngine;
  let board: BoardDoc;
  let container: HTMLElement;
  let stickyId: string;
  const engineInput = signal<BoardEngine | undefined>(undefined);

  beforeEach(async () => {
    localStorage.clear();
    TestBed.inject(EmojiCatalog).loadRaw = async () => RAW;
    container = document.createElement('div');
    document.body.appendChild(container);
    board = new BoardDoc();
    engine = new BoardEngine(container, board);
    stickyId = board.addBlock({
      type: 'core.sticky',
      x: 100,
      y: 100,
      w: 200,
      h: 200,
      props: { color: '#fde68a' },
      text: 'hello',
    });
    engine.flush();
    // the block above is its own undo step, apart from what is inserted later
    engine.stopCapturing();
    engineInput.set(engine);
    fixture = TestBed.createComponent(BoardTextEmoji, {
      bindings: [inputBinding('engine', engineInput)],
    });
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.nativeElement.remove();
    engine.destroy();
    board.destroy();
    container.remove();
  });

  const editor = (): HTMLTextAreaElement | null => container.querySelector('textarea');
  const emojiButton = (): HTMLButtonElement => buttonByLabel(fixture, 'Insert emoji');

  async function startEditing(): Promise<void> {
    engine.startTextEdit(stickyId);
    engine.flush();
    await fixture.whenStable();
  }

  async function openPicker(): Promise<void> {
    emojiButton().click();
    await fixture.whenStable();
  }

  describe('button', () => {
    it('when no text is edited then there is no emoji button', () => {
      expect(all(fixture, 'button'), 'buttons').toHaveLength(0);
    });

    it('when a text is edited then the emoji button shows, and it is gone when the edit ends', async () => {
      await startEditing();
      expect(all(fixture, '[data-testid=text-emoji]'), 'while editing').toHaveLength(1);

      editor()?.blur();
      engine.flush();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=text-emoji]'), 'after').toHaveLength(0);
    });

    it('when the button is pressed then the text keeps the focus (the mouse down is cancelled)', async () => {
      await startEditing();
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });

      emojiButton().dispatchEvent(down);

      expect(down.defaultPrevented, 'default prevented').toBe(true);
      expect(document.activeElement, 'focus').toBe(editor());
    });
  });

  describe('picking', () => {
    it('when an emoji is picked then it is inserted at the caret and the focus stays in the text', async () => {
      await startEditing();
      (editor() as HTMLTextAreaElement).setSelectionRange(2, 2);
      await openPicker();
      expect(all(fixture, '[role=dialog]'), 'picker open').toHaveLength(1);
      expect(editor(), 'editor stays while the picker is open').not.toBeNull();

      all<HTMLButtonElement>(fixture, '[data-index]')
        .find((b) => b.getAttribute('aria-label') === 'party popper')
        ?.click();
      await fixture.whenStable();

      expect(board.textOf(stickyId), 'text').toBe('he🎉llo');
      expect(all(fixture, '[role=dialog]'), 'picker closed').toHaveLength(0);
      expect(document.activeElement, 'focus').toBe(editor());
    });

    it('when an emoji was inserted then undo takes it out again', async () => {
      await startEditing();
      await openPicker();
      all<HTMLButtonElement>(fixture, '[data-index]')[0]?.click();
      await fixture.whenStable();
      editor()?.blur();

      engine.undo();

      expect(board.textOf(stickyId), 'text').toBe('hello');
    });

    it('when the search field has the focus then the edit is not ended by the blur', async () => {
      await startEditing();
      await openPicker();
      await fixture.whenStable();

      expect(document.activeElement?.getAttribute('type'), 'search field has the focus').toBe(
        'search',
      );
      expect(editor(), 'editor').not.toBeNull();
    });
  });

  describe('closing', () => {
    it('when Escape is pressed in the picker then it closes and the text has the focus again', async () => {
      await startEditing();
      await openPicker();

      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await fixture.whenStable();

      expect(all(fixture, '[role=dialog]'), 'picker').toHaveLength(0);
      expect(editor(), 'editor still open').not.toBeNull();
      expect(document.activeElement, 'focus').toBe(editor());
      expect(board.textOf(stickyId), 'text unchanged').toBe('hello');
    });

    it('when the button is pressed again then the picker closes', async () => {
      await startEditing();
      await openPicker();

      await openPicker();

      expect(all(fixture, '[role=dialog]'), 'picker').toHaveLength(0);
      expect(document.activeElement, 'focus').toBe(editor());
    });

    it('when the pointer goes down outside then the picker closes', async () => {
      await startEditing();
      await openPicker();

      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await fixture.whenStable();

      expect(all(fixture, '[role=dialog]'), 'picker').toHaveLength(0);
    });

    it('when the edit ends under an open picker then the picker goes with it', async () => {
      await startEditing();
      await openPicker();

      engine.setTool('rect');
      engine.flush();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=text-emoji]'), 'button and picker').toHaveLength(0);
    });
  });
});
