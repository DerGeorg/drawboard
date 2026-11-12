import { Component, computed, input, output } from '@angular/core';

import { formatBytes } from '../../../../util/format-bytes';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { UPLOAD_LIMITS_TEXT, UploadItem } from '../board-uploads';

/**
 * The floating list of running and finished uploads at the bottom of the board: progress per
 * file, the limits, and the reason (with request id) when the server refused one.
 */
@Component({
  selector: 'drawboard-board-upload-panel',
  imports: [Icon],
  templateUrl: './board-upload-panel.html',
})
export class BoardUploadPanel {
  readonly items = input.required<readonly UploadItem[]>();
  readonly cleared = output();

  protected readonly limits = UPLOAD_LIMITS_TEXT;
  protected readonly size = formatBytes;
  protected readonly busy = computed(() =>
    this.items().some((i) => i.status === 'queued' || i.status === 'uploading'),
  );

  protected percent(item: UploadItem): number {
    return Math.round(item.progress * 100);
  }

  @WithSpan('BoardUploadPanel.clear')
  protected clear(): void {
    this.cleared.emit();
  }
}
