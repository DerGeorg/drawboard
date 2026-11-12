import { Component, computed, input } from '@angular/core';
import { BoardRole } from '@apps/drawboard-api';

/** Complete class strings (Tailwind finds them) and the label per role. */
const BADGES: Readonly<Record<BoardRole, { label: string; css: string }>> = {
  OWNER: { label: 'Owner', css: 'badge st-badge-green-simple' },
  EDITOR: { label: 'Editor', css: 'badge st-badge-yellow-simple' },
  COMMENTER: { label: 'Commenter', css: 'badge st-badge-grey-simple' },
  VIEWER: { label: 'Viewer', css: 'badge st-badge-grey-simple' },
};

/** The user's role on a board as a small pill. */
@Component({
  selector: 'drawboard-role-badge',
  templateUrl: './role-badge.html',
  // inline-flex: in a flex row a plain host becomes a block whose line box (strut) moves the badge
  host: { class: 'inline-flex' },
})
export class RoleBadge {
  readonly role = input.required<BoardRole>();

  protected readonly badge = computed(() => BADGES[this.role()]);
}
