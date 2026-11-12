import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { GuestSession } from '../../../../services/guest-session';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';

/**
 * "Guest · Name" with a Leave button: shown wherever a guest looks at a board or folder, so
 * nobody mistakes the session for a signed-in one. Leaving forgets the guest token and the link
 * token (memory only) and goes back to the join page.
 */
@Component({
  selector: 'drawboard-guest-badge',
  imports: [Icon],
  templateUrl: './guest-badge.html',
  // inline-flex: a flex item with inline content would get a line box around the badge
  host: { class: 'inline-flex' },
})
export class GuestBadge {
  private readonly session = inject(GuestSession);
  private readonly router = inject(Router);

  protected readonly guest = this.session.user;

  @WithSpan('GuestBadge.leave')
  protected async leave(): Promise<void> {
    this.session.clear();
    await this.router.navigate(['/s']);
  }
}
