import { Component, computed, input, output } from '@angular/core';

import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';

/**
 * "+ New board": the entry point of the library. It only asks for the dialog (`requested`); the
 * library page shows it (components/pages/boards/new-board-dialog). Shown as a card in the grid
 * or as a button in the sidebar.
 */
@Component({
  selector: 'drawboard-board-create',
  imports: [Icon],
  templateUrl: './board-create.html',
  // block: the card fills its grid cell, the button its column
  host: { class: 'block' },
})
export class BoardCreate {
  readonly variant = input<'card' | 'button'>('card');
  readonly requested = output();

  protected readonly card = computed(() => this.variant() === 'card');

  @WithSpan('BoardCreate.request')
  protected request(): void {
    this.requested.emit();
  }
}
