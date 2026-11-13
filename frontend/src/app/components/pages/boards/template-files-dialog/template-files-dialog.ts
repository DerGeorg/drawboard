import { Component, computed, input, output } from '@angular/core';

import { WithSpan } from '../../../../util/tracing';
import { Modal } from '../../../shared/modal/modal';

/** Megabytes with one decimal ("12.4 MB"); decimal units like the upload limits. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Asked before a copy of a template that has files (T9): how many and how big they are
 * together, and the choice to copy them or leave them out. `chosen` carries `true` for "with
 * files".
 */
@Component({
  selector: 'drawboard-template-files-dialog',
  imports: [Modal],
  templateUrl: './template-files-dialog.html',
})
export class TemplateFilesDialog {
  readonly count = input.required<number>();
  readonly bytes = input.required<number>();
  readonly chosen = output<boolean>();
  readonly closed = output();

  protected readonly size = computed(() => megabytes(this.bytes()));

  @WithSpan('TemplateFilesDialog.choose')
  protected choose(withFiles: boolean): void {
    this.chosen.emit(withFiles);
  }
}
