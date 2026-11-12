import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Folder } from '@apps/drawboard-api';

import { Icon } from '../../../shared/icon/icon';
import { RoleBadge } from '../../../shared/role-badge/role-badge';

/** A folder in the library grid: opens its boards. Shows the user's role on it. */
@Component({
  selector: 'drawboard-folder-card',
  imports: [RouterLink, Icon, RoleBadge],
  templateUrl: './folder-card.html',
})
export class FolderCard {
  readonly folder = input.required<Folder>();
  /** Which library view the folder is opened in: the user's own space or "Shared with me". */
  readonly view = input<'mine' | 'shared'>('mine');
}
