import { Component, computed, input, output, signal } from '@angular/core';
import { BoardRole } from '@apps/drawboard-api';

import { WithSpan } from '../../../../util/tracing';
import { Modal } from '../../../shared/modal/modal';
import { ShareLinks } from '../share-links/share-links';
import { SharePeople } from '../share-people/share-people';
import { ShareKind } from '../share-target';

type Tab = 'people' | 'links';

/**
 * The Share dialog of a board or a folder, opened from the editor, the card menu and the
 * folder menu. The owner manages people and links; everyone else sees the member list
 * read-only (links are the owner's business - the API refuses them for other roles).
 */
@Component({
  selector: 'drawboard-share-dialog',
  imports: [Modal, SharePeople, ShareLinks],
  templateUrl: './share-dialog.html',
})
export class ShareDialog {
  readonly kind = input.required<ShareKind>();
  readonly resourceId = input.required<string>();
  /** Title of the board or name of the folder. */
  readonly name = input.required<string>();
  /** The caller's role on the board or folder. */
  readonly role = input.required<BoardRole>();
  readonly closed = output();

  protected readonly tab = signal<Tab>('people');
  protected readonly isOwner = computed(() => this.role() === BoardRole.OWNER);
  protected readonly heading = computed(
    () => `Share ${this.kind() === 'board' ? 'board' : 'folder'} “${this.name()}”`,
  );

  @WithSpan('ShareDialog.show')
  protected show(tab: Tab): void {
    this.tab.set(tab);
  }

  @WithSpan('ShareDialog.close')
  protected close(): void {
    this.closed.emit();
  }
}
