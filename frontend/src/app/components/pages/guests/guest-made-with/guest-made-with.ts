import { Component, inject, signal } from '@angular/core';

import { RUNTIME_CONFIG } from '../../../../services/runtime-config';
import { AboutDialog } from '../../../shared/about-dialog/about-dialog';

/**
 * "Made with Drawboard · Host your own": the quiet line for guests, who are exactly the people
 * using Drawboard on someone else's instance. "Host your own" goes to the product site and is
 * left out when the operator switched the promotion off; "Made with Drawboard" always opens the
 * About dialog - a guest has no menu, so that is where the source code (AGPL-3.0) is offered.
 */
@Component({
  selector: 'drawboard-guest-made-with',
  imports: [AboutDialog],
  templateUrl: './guest-made-with.html',
  // inline-flex: sits in a corner or a text line without a line box of its own
  host: { class: 'inline-flex' },
})
export class GuestMadeWith {
  protected readonly aboutUrl = inject(RUNTIME_CONFIG).aboutUrl;
  protected readonly aboutOpen = signal(false);
}
