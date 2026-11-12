import { Component, inject, input, model, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Auth } from '../../../services/auth';
import { RUNTIME_CONFIG } from '../../../services/runtime-config';
import { WithSpan } from '../../../util/tracing';
import { Avatar } from '../../shared/avatar/avatar';
import { DgLogo } from '../../shared/dg-logo/dg-logo';
import { Icon } from '../../shared/icon/icon';
import { IconName } from '../../shared/icon/icons';

/** The library views the sidebar switches between. */
export type LibraryView = 'recent' | 'mine' | 'shared' | 'trash';

interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  view: LibraryView;
}

/**
 * The frame of the library: a sidebar (Recent, My boards with the folder tree projected below
 * it as `[sidebar-folders]`, Shared with me, Trash), a top bar with the board search and the user menu, and the page in between.
 * Below 768 px the sidebar is a drawer opened from the top bar. The search text is a two-way
 * `model`: the page filters what it has loaded.
 */
@Component({
  selector: 'drawboard-library-shell',
  imports: [RouterLink, Avatar, DgLogo, Icon],
  templateUrl: './library-shell.html',
  // the library fills the window; the page scrolls inside the frame
  host: { class: 'block h-dvh', '(keydown.escape)': 'closeDrawer(); closeUserMenu()' },
})
export class LibraryShell {
  private readonly auth = inject(Auth);
  private readonly environment = inject(RUNTIME_CONFIG).environment;

  readonly view = input<LibraryView>('recent');
  readonly search = model('');
  /** A board card was dropped onto "My boards" (the top level). */
  readonly rootDrop = output();

  protected readonly user = this.auth.user;
  /** Everything but prod carries a badge, so nobody mistakes dev for prod. */
  protected readonly environmentBadge = this.environment === 'prod' ? undefined : this.environment;
  protected readonly nav: readonly NavItem[] = [
    { id: 'recent', label: 'Recent', icon: 'clock', view: 'recent' },
    { id: 'mine', label: 'My boards', icon: 'board', view: 'mine' },
    { id: 'shared', label: 'Shared with me', icon: 'users', view: 'shared' },
    { id: 'trash', label: 'Trash', icon: 'trash', view: 'trash' },
  ];

  protected readonly drawerOpen = signal(false);
  protected readonly userMenuOpen = signal(false);

  @WithSpan('LibraryShell.toggleDrawer')
  protected toggleDrawer(): void {
    this.drawerOpen.update((open) => !open);
  }

  protected setSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  /** "My boards" is a drop target for board cards (moves to the top level). */
  protected allowDrop(event: DragEvent, target: LibraryView): void {
    if (target === 'mine') {
      event.preventDefault();
    }
  }

  protected drop(event: DragEvent, target: LibraryView): void {
    if (target === 'mine') {
      event.preventDefault();
      this.rootDrop.emit();
    }
  }

  protected closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  @WithSpan('LibraryShell.toggleUserMenu')
  protected toggleUserMenu(): void {
    this.userMenuOpen.update((open) => !open);
  }

  protected closeUserMenu(): void {
    this.userMenuOpen.set(false);
  }

  @WithSpan('LibraryShell.logout')
  protected logout(): void {
    void this.auth.logout();
  }

  /** Complete class strings (Tailwind finds them) for a sidebar entry. */
  protected navClass(active: boolean): string {
    const base =
      'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-(--color-st-primary) ';
    return (
      base +
      (active
        ? 'bg-(--color-st-yellow)/25 text-(--color-st-primary)'
        : 'text-(--color-st-grey) hover:bg-(--color-st-white-darker)')
    );
  }
}
