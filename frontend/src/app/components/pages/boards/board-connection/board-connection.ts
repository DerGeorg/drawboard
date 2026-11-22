import { Component, computed, input } from '@angular/core';

import type { ProviderState, ProviderStatus } from '@apps/drawboard-engine';

/** Complete class strings (Tailwind finds them), label and explanation per connection status. */
const STATES: Readonly<
  Record<ProviderStatus, { label: string; css: string; dot: string; hint: string }>
> = {
  connecting: {
    label: 'Connecting…',
    css: 'badge st-badge-grey-simple',
    dot: 'bg-(--color-st-grey)',
    hint: 'Changes are kept and sent once connected.',
  },
  synced: {
    label: 'Live',
    css: 'badge st-badge-green-simple',
    dot: 'bg-(--color-st-green-def)',
    hint: 'Changes are saved live.',
  },
  readonly: {
    label: 'Live, read only',
    css: 'badge st-badge-grey-simple',
    dot: 'bg-(--color-st-grey)',
    hint: 'You can watch, not edit.',
  },
  offline: {
    label: 'Offline',
    css: 'badge st-badge-yellow-simple',
    dot: 'bg-(--color-st-yellow)',
    hint: 'Changes are kept and sent when the connection is back.',
  },
  full: {
    label: 'Board full',
    css: 'badge st-badge-yellow-simple',
    dot: 'bg-(--color-st-yellow)',
    hint: 'The board reached its size limit; new changes are not saved.',
  },
  denied: {
    label: 'No access',
    css: 'badge st-badge-yellow-simple',
    dot: 'bg-(--color-st-yellow)',
    hint: 'You no longer have access to this board.',
  },
};

/** The state of the board's live connection as a small pill in the editor's top bar. */
@Component({
  selector: 'drawboard-board-connection',
  templateUrl: './board-connection.html',
  // inline-flex: in a flex row a plain host becomes a block whose line box (strut) moves the badge
  host: { class: 'inline-flex' },
})
export class BoardConnection {
  /** Undefined before the connection was opened: nothing is shown. */
  readonly state = input<ProviderState | undefined>();

  protected readonly view = computed(() => {
    const state = this.state();
    if (!state) {
      return undefined;
    }
    const base = STATES[state.status];
    return state.reloadRequired
      ? { ...base, hint: 'A change was too large to send. Reload the board.' }
      : base;
  });
}
