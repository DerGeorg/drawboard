import { Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';

import { BoardEngine, SelectionAnchor } from '../../../../../board-engine/engine';
import { WithSpan } from '../../../../util/tracing';
import { placeToolbar } from '../../../../util/toolbar-placement';
import { EmojiPicker } from '../../../shared/emoji-picker/emoji-picker';

/** Half the picker's width: it stays this far from the window's edges. */
const HALF_WIDTH = 170;

/**
 * The emoji button that floats over a text while it is edited (sticky note, text, shape) and the
 * picker it opens. The picked emoji goes in at the caret the way typing does: one Yjs edit, so
 * undo works and the others see it. The text keeps its focus: the button does not take it, and
 * while the picker is open the engine holds the editor (`holdTextEdit`) so it does not end when
 * the search field gets the focus.
 */
@Component({
  selector: 'drawboard-board-text-emoji',
  imports: [EmojiPicker],
  templateUrl: './board-text-emoji.html',
  host: {
    '(document:pointerdown)': 'closeOnOutside($event)',
    '(keydown.escape)': 'close()',
  },
})
export class BoardTextEmoji {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly engine = input<BoardEngine>();

  private readonly anchor = signal<SelectionAnchor>(null);
  private readonly viewport = signal({ w: 0, h: 0 });
  protected readonly open = signal(false);
  private release: (() => void) | undefined;

  protected readonly placement = computed(() => {
    const anchor = this.anchor();
    return anchor ? placeToolbar(anchor, this.viewport()) : undefined;
  });
  protected readonly left = computed(
    () => `clamp(${HALF_WIDTH}px, ${this.placement()?.x ?? 0}px, calc(100% - ${HALF_WIDTH}px))`,
  );

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      if (!engine) {
        return;
      }
      const setAnchor = (anchor: SelectionAnchor): void => {
        const el = this.host.nativeElement;
        this.viewport.set({ w: el.clientWidth, h: el.clientHeight });
        this.anchor.set(anchor);
        if (!anchor) {
          this.dismiss();
        }
      };
      setAnchor(engine.textEditAnchor);
      const off = engine.textEditAnchorChanged.on(setAnchor);
      onCleanup(() => {
        off();
        this.dismiss();
      });
    });
  }

  /** The button must not take the focus from the text (a mouse down would blur the editor). */
  @WithSpan('BoardTextEmoji.keepFocus')
  protected keepFocus(event: Event): void {
    event.preventDefault();
  }

  @WithSpan('BoardTextEmoji.toggle')
  protected toggle(): void {
    if (this.open()) {
      this.dismiss();
      return;
    }
    // hold first: the picker takes the focus as soon as it is shown
    this.release = this.engine()?.holdTextEdit();
    this.open.set(this.release !== undefined);
  }

  @WithSpan('BoardTextEmoji.pick')
  protected pick(emoji: string): void {
    this.engine()?.insertIntoEditedText(emoji);
    this.dismiss();
  }

  @WithSpan('BoardTextEmoji.close')
  protected close(): void {
    this.dismiss();
  }

  protected closeOnOutside(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.dismiss();
    }
  }

  /** Closes the picker and gives the focus back to the text, caret where it was. */
  private dismiss(): void {
    this.open.set(false);
    this.release?.();
    this.release = undefined;
  }
}
