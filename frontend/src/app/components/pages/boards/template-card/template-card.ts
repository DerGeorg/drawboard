import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Board } from '@apps/drawboard-api';

import { relativeTime } from '../../../../util/relative-time';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { TemplateOwners } from '../template-owners';
import { RoleBadge } from '../../../shared/role-badge/role-badge';

/**
 * One template of the user's library on the Templates page: title, "edited <time>", the role
 * on it, "Use" (a new board as a copy of it) and "Open" (the template is a normal board:
 * whoever may edit it edits it there).
 */
@Component({
  selector: 'drawboard-template-card',
  imports: [Icon, RoleBadge, RouterLink],
  templateUrl: './template-card.html',
})
export class TemplateCard {
  protected readonly owners = inject(TemplateOwners);

  readonly board = input.required<Board>();
  /** A copy is being made: the button waits. */
  readonly busy = input(false);
  readonly use = output();

  protected readonly edited = computed(() => relativeTime(this.board().updatedAt));

  @WithSpan('TemplateCard.requestUse')
  protected requestUse(): void {
    this.use.emit();
  }
}
