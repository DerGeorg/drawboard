import { Component, computed, inject, input, output, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { BoardVersion, CollabService } from '@apps/drawboard-api';

import { formatBytes } from '../../../../util/format-bytes';
import { relativeTime } from '../../../../util/relative-time';
import { WithSpan } from '../../../../util/tracing';
import { LoadError } from '../../../shared/load-error/load-error';
import { Modal } from '../../../shared/modal/modal';
import { VersionActions } from '../version-actions';

/**
 * "Version history" of a board (owner only): the snapshots the server keeps, newest first.
 * Restoring asks for a confirmation first - it replaces the drawing for everybody, and edits
 * that were not saved yet are lost. The dialog closes after a successful restore; the editor
 * then receives close code 4410 and reloads the restored drawing (BoardCollab).
 */
@Component({
  selector: 'drawboard-version-history',
  imports: [LoadError, Modal],
  templateUrl: './version-history.html',
})
export class VersionHistory {
  private readonly collabApi = inject(CollabService);
  private readonly actions = inject(VersionActions);

  readonly boardId = input.required<string>();
  readonly closed = output();

  protected readonly versions = rxResource({
    params: () => ({ boardId: this.boardId() }),
    stream: ({ params }) => this.collabApi.listBoardVersions(params),
  });
  protected readonly items = computed<BoardVersion[]>(() =>
    this.versions.hasValue() ? this.versions.value().items : [],
  );
  /** Id of the version that asks "restore?" right now. */
  protected readonly confirming = signal<string | undefined>(undefined);
  protected readonly busy = signal(false);

  private readonly dateFormat = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  protected when(version: BoardVersion): string {
    return this.dateFormat.format(new Date(version.createdAt));
  }

  protected ago(version: BoardVersion): string {
    return relativeTime(version.createdAt);
  }

  protected size(version: BoardVersion): string {
    return formatBytes(version.size);
  }

  @WithSpan('VersionHistory.ask')
  protected ask(version: BoardVersion): void {
    this.confirming.set(version.id);
  }

  @WithSpan('VersionHistory.cancel')
  protected cancel(): void {
    this.confirming.set(undefined);
  }

  @WithSpan('VersionHistory.close')
  protected close(): void {
    this.closed.emit();
  }

  @WithSpan('VersionHistory.restore')
  protected async restore(version: BoardVersion): Promise<void> {
    this.busy.set(true);
    try {
      // started before the first await: VersionActions' span becomes a child of this one
      if (await this.actions.restore(this.boardId(), version)) {
        this.closed.emit();
      }
    } finally {
      this.busy.set(false);
      this.confirming.set(undefined);
    }
  }
}
