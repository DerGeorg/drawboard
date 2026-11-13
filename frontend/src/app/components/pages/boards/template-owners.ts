import { HttpContext } from '@angular/common/http';
import { Service, inject, signal } from '@angular/core';
import { Board, SharingService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { Auth } from '../../../services/auth';
import { WithSpan } from '../../../util/tracing';

/**
 * Who made a template: the display name of its owner, for lists of templates of other people.
 * The names come from the member list of a board of that owner (`listBoardMembers`, display
 * names only, S6.9), asked once per owner; a failure just leaves the name out. The user's own
 * templates say "You".
 */
@Service()
export class TemplateOwners {
  private readonly sharingApi = inject(SharingService);
  private readonly auth = inject(Auth);
  private readonly context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());
  private readonly asked = new Set<string>();

  /** The owner's name, or undefined while it is unknown. Reads a signal: usable in templates. */
  name(board: Board): string | undefined {
    return board.ownerId === this.auth.user()?.id ? 'You' : this.names().get(board.ownerId);
  }

  /** Looks up the owners of `boards` that are not known yet. */
  @WithSpan('TemplateOwners.resolve')
  async resolve(boards: readonly Board[]): Promise<void> {
    const me = this.auth.user()?.id;
    const todo = new Map<string, Board>();
    for (const board of boards) {
      if (board.ownerId !== me && !this.asked.has(board.ownerId) && !todo.has(board.ownerId)) {
        todo.set(board.ownerId, board);
      }
    }
    for (const [ownerId, board] of todo) {
      this.asked.add(ownerId);
      try {
        const members = await firstValueFrom(
          this.sharingApi.listBoardMembers({ boardId: board.id }, 'body', false, {
            context: this.context,
          }),
        );
        if (members.owner.userId === ownerId && members.owner.displayName) {
          this.names.update((all) => new Map(all).set(ownerId, members.owner.displayName));
        }
      } catch {
        // no name: the card shows none
      }
    }
  }
}
