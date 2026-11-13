import { Component, computed, input } from '@angular/core';

import type { BoardFile } from '../../../../../board-engine/io/board-file';
import { previewOf } from '../../../../../board-engine/templates/template-preview';

/**
 * A small flat picture of a board file for template cards: frames, notes, kanban columns and
 * text lines as boxes in their place. Decorative (the card's title says what it is).
 */
@Component({
  selector: 'drawboard-template-preview',
  templateUrl: './template-preview.html',
  host: { class: 'block' },
})
export class TemplatePreview {
  readonly file = input.required<BoardFile>();

  protected readonly preview = computed(() => previewOf(this.file()));
}
