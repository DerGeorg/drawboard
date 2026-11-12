import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { Auth } from '../../../services/auth';
import { RUNTIME_CONFIG } from '../../../services/runtime-config';
import { DgLogo } from '../../shared/dg-logo/dg-logo';

/** Top bar: app name, navigation, environment badge (not on prod), display name of the signed-in user and logout. */
@Component({
  selector: 'drawboard-header',
  imports: [RouterLink, RouterLinkActive, DgLogo],
  templateUrl: './header.html',
})
export class Header {
  protected readonly auth = inject(Auth);
  private readonly environment = inject(RUNTIME_CONFIG).environment;

  /** Everything but prod carries a badge, so nobody mistakes dev for prod. */
  protected readonly environmentBadge = this.environment === 'prod' ? undefined : this.environment;

  /**
   * One class string for the navigation links (a literal, so Tailwind finds it). The active link
   * (routerLinkActive sets aria-current="page") is amber; hover wins over it, as before.
   */
  protected readonly navLinkClass =
    'rounded-lg px-3 py-2 text-sm font-medium text-white/75 transition-colors duration-200 ' +
    'hover:bg-white/10 hover:text-(--color-st-on-accent) ' +
    'aria-[current=page]:bg-white/10 aria-[current=page]:text-(--color-st-yellow) ' +
    'aria-[current=page]:hover:text-(--color-st-on-accent)';

  protected logout(): void {
    void this.auth.logout();
  }
}
