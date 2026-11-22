import { Component, computed, inject, input } from '@angular/core';

import { type BoardFile, previewOf } from '@apps/drawboard-engine';
import { Theme } from '../../../../services/theme';

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
  private readonly theme = inject(Theme);

  readonly file = input.required<BoardFile>();

  /** Drawn for the current theme: the colours of the file stay, the display is mapped. */
  protected readonly preview = computed(() => previewOf(this.file(), this.theme.resolved()));
  protected readonly frameStroke = computed(() =>
    this.theme.resolved() === 'dark' ? '#334155' : '#cbd5e1',
  );
}
