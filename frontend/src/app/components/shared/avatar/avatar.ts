import { Component, computed, input } from '@angular/core';

import { initials } from '../../../util/initials';

/** A round badge with the initials of a person on their colour. */
@Component({
  selector: 'drawboard-avatar',
  templateUrl: './avatar.html',
  // inline-flex: as a flex item the host would otherwise get a line box around the circle
  host: { class: 'inline-flex' },
})
export class Avatar {
  readonly name = input.required<string>();
  /** Any colour CSS accepts; the caller sanitises colours that come from other people. */
  readonly color = input('#475569');
  readonly size = input<'sm' | 'md'>('md');

  protected readonly letters = computed(() => initials(this.name()));
  protected readonly sizeClass = computed(() =>
    this.size() === 'sm' ? 'size-7 text-xs' : 'size-8 text-sm',
  );
}
