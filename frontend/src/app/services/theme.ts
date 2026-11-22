import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injector,
  Service,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { UsersService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import {
  ResolvedTheme,
  ThemeMode,
  applyThemeAttribute,
  parseThemeMode,
  readStoredTheme,
  storeTheme,
} from '../util/theme-mode';
import { Auth } from './auth';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Light or dark for the whole app: the choice (`mode`: System, Light, Dark) and what it
 * resolves to (`resolved`: System follows the operating system, also while the app is open).
 *
 * Where the choice lives: in the browser (localStorage, one key, a cache that main.ts applies
 * before the first paint) and, for a signed-in user, in their profile (`CurrentUser.theme`), so
 * it follows them to every device. After sign-in the profile wins over the cache. Guests (and
 * anyone not signed in) keep the choice in the browser only and never cause an API call.
 *
 * `html[data-theme]` is `light` or `dark` for a fixed choice and absent for System; the CSS
 * handles the rest (styles.css).
 */
@Service()
export class Theme {
  // optional: components that only show the theme (the board toolbars) are rendered in tests
  // and previews without a login; the API client is looked up only when something is saved
  private readonly auth = inject(Auth, { optional: true });
  private readonly injector = inject(Injector);
  private readonly root = inject(DOCUMENT).documentElement;

  private readonly current = signal<ThemeMode>(readStoredTheme() ?? 'SYSTEM');
  private readonly systemDark = signal(false);
  /** What the server holds for this user; where a failed save falls back to. */
  private serverMode: ThemeMode | undefined;
  private saves = 0;

  readonly mode = this.current.asReadonly();
  readonly resolved = computed<ResolvedTheme>(() => {
    const mode = this.current();
    return mode === 'SYSTEM'
      ? this.systemDark()
        ? 'dark'
        : 'light'
      : (mode.toLowerCase() as ResolvedTheme);
  });

  constructor() {
    this.follow();
    // a signed-in user's saved choice wins over what this browser cached
    effect(() => {
      const user = this.auth?.user();
      const saved = user && !this.auth?.guest() ? parseThemeMode(user.theme) : undefined;
      untracked(() => {
        this.serverMode = saved;
        if (saved) {
          this.applyLocal(saved);
        }
      });
    });
    applyThemeAttribute(this.root, this.current());
  }

  /**
   * The user picked a mode: it applies at once and is cached; a signed-in user's profile is
   * updated too. If that fails (the error interceptor shows the toast) the last saved mode is
   * restored - unless the user has picked another one in the meantime.
   */
  async set(mode: ThemeMode): Promise<void> {
    this.applyLocal(mode);
    if (!this.auth?.user() || this.auth.guest()) {
      return;
    }
    const save = ++this.saves;
    try {
      const stored = await firstValueFrom(
        this.injector.get(UsersService).updateUserPreferences({ userPreferences: { theme: mode } }),
      );
      this.serverMode = parseThemeMode(stored.theme) ?? mode;
    } catch {
      if (save === this.saves && this.serverMode) {
        this.applyLocal(this.serverMode);
      }
    }
  }

  private applyLocal(mode: ThemeMode): void {
    this.current.set(mode);
    storeTheme(mode);
    applyThemeAttribute(this.root, mode);
  }

  /** `systemDark` mirrors the operating system's setting, including later changes. */
  private follow(): void {
    const query = this.root.ownerDocument.defaultView?.matchMedia?.(DARK_QUERY);
    if (!query) {
      return;
    }
    this.systemDark.set(query.matches);
    const listener = (event: MediaQueryListEvent): void => this.systemDark.set(event.matches);
    query.addEventListener('change', listener);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', listener));
  }
}
