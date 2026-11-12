import { Component, input, signal } from '@angular/core';

import { WithSpan } from '../../../util/tracing';
import { Icon } from '../icon/icon';

/**
 * A "⋯" button with a floating menu. The entries are projected as
 * `<button role="menuitem" class="panel-item">`; a click on any entry (or the backdrop, or
 * Escape) closes the menu again.
 */
@Component({
  selector: 'drawboard-action-menu',
  imports: [Icon],
  templateUrl: './action-menu.html',
  // the button sits above a stretched card link (z-10); a block host keeps the menu anchored
  host: {
    class: 'relative z-10 block',
    '(keydown.escape)': 'close()',
    '(click)': 'closeOnItem($event)',
  },
})
export class ActionMenu {
  /** Accessible name of the button and the menu, e.g. "Folder actions". */
  readonly label = input.required<string>();
  /** Opens above the button (cards at the bottom of the window) or below it. */
  readonly placement = input<'above' | 'below'>('below');

  protected readonly open = signal(false);

  @WithSpan('ActionMenu.toggle')
  protected toggle(): void {
    this.open.update((value) => !value);
  }

  /** A click on a menu entry (not on the button or the backdrop) closes the menu. */
  protected closeOnItem(event: Event): void {
    if ((event.target as HTMLElement).closest('[role=menuitem]')) {
      this.close();
    }
  }

  protected close(): void {
    this.open.set(false);
  }
}
