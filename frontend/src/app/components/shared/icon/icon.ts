import { Component, computed, input } from '@angular/core';

import { ICONS, IconName } from './icons';

/** One of the inline stroke icons (see icons.ts). Decorative: the button around it carries the label. */
@Component({
  selector: 'drawboard-icon',
  templateUrl: './icon.html',
})
export class Icon {
  readonly name = input.required<IconName>();

  protected readonly path = computed(() => ICONS[this.name()]);
}
