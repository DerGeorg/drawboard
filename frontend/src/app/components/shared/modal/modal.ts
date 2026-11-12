import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

import { Icon } from '../icon/icon';

let nextId = 0;

/**
 * A modal dialog (DaisyUI modal in the floating-panel look): the parent renders it with
 * `@if (open)` and listens to `closed`. Escape, the backdrop and the close button emit
 * `closed`; focus moves to the close button on open and back to what opened it on close.
 */
@Component({
  selector: 'drawboard-modal',
  imports: [Icon],
  templateUrl: './modal.html',
  host: { '(keydown.escape)': 'closed.emit()' },
})
export class Modal {
  readonly heading = input.required<string>();
  /** Wider box for dialogs with lists (share dialog). */
  readonly wide = input(false);
  readonly closed = output();

  protected readonly titleId = `modal-title-${nextId++}`;
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  constructor() {
    const opener = document.activeElement as HTMLElement | null;
    afterNextRender(() => this.closeButton()?.nativeElement.focus());
    inject(DestroyRef).onDestroy(() => opener?.focus?.());
  }
}
