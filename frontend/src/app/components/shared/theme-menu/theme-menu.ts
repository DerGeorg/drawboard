import { Component, computed, inject, signal } from '@angular/core';

import { Auth } from '../../../services/auth';
import { GifConsentStore } from '../../../services/gif-consent';
import { RUNTIME_CONFIG } from '../../../services/runtime-config';
import { Theme } from '../../../services/theme';
import { WithSpan } from '../../../util/tracing';
import { Icon } from '../icon/icon';
import { ThemeSwitch } from '../theme-switch/theme-switch';

/**
 * A button that opens a small menu with the theme choice (System, Light, Dark) and, once the
 * viewer agreed to load GIFs, "Forget GIF consent". Used on the
 * board page, where there is no account menu and guests have no menu at all. The icon shows
 * what is drawn now.
 */
@Component({
  selector: 'drawboard-theme-menu',
  imports: [Icon, ThemeSwitch],
  templateUrl: './theme-menu.html',
  // the menu is positioned against this element; Escape closes it
  host: { class: 'relative', '(keydown.escape)': 'close()' },
})
export class ThemeMenu {
  private readonly theme = inject(Theme);
  private readonly auth = inject(Auth);
  private readonly consent = inject(GifConsentStore);
  private readonly gifsOnInstance =
    inject(RUNTIME_CONFIG, { optional: true })?.gifsEnabled === true;

  protected readonly open = signal(false);
  protected readonly icon = computed(() => (this.theme.resolved() === 'dark' ? 'moon' : 'sun'));

  /** The viewer agreed to load GIFs from GIPHY: they can take it back here (G10). */
  protected readonly canForgetGifs = computed(() => {
    this.consent.revision();
    return this.gifsOnInstance && this.consent.granted();
  });

  /** G3, for admins: the backend key and the frontend switch should both be on or both off. */
  protected readonly gifsHalfOn = computed(() => {
    const user = this.auth.user();
    return user?.admin === true && user.gifsEnabled !== this.gifsOnInstance;
  });

  @WithSpan('ThemeMenu.forgetGifs')
  protected forgetGifs(): void {
    this.consent.forget();
    this.close();
  }

  @WithSpan('ThemeMenu.toggle')
  protected toggle(): void {
    this.open.update((open) => !open);
  }

  @WithSpan('ThemeMenu.close')
  protected close(): void {
    this.open.set(false);
  }
}
