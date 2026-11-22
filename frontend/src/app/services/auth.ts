import { Signal } from '@angular/core';

import type { ThemeMode } from '../util/theme-mode';
import type { GuestUser } from './guest-session';

/** The signed-in user as the backend knows them (GET /api/users/me). */
export interface AuthUser {
  /** The app's own user id (not the provider's `sub`). */
  readonly id: string;
  readonly username: string;
  /** Always set: the profile's display name, else the username. */
  readonly displayName: string;
  /** Instance administrator. */
  readonly admin: boolean;
  /** The instance allows share links for guests without an account (`CurrentUser.guestLinksEnabled`). */
  readonly guestLinksEnabled: boolean;
  /** This instance has a GIPHY key: GIF search works (`CurrentUser.gifsEnabled`, G3). */
  readonly gifsEnabled: boolean;
  /** The saved colour theme choice of the profile (`CurrentUser.theme`). */
  readonly theme: ThemeMode;
}

/**
 * What the app knows about the login. Components, guards and interceptors depend on this
 * abstraction only - never on the OIDC library - so it can be swapped in one file and tests
 * use a fake (test/fake-auth.ts). Provided in config.ts: OidcAuth.
 *
 * There are no permission claims: what a user may do with a board comes from the backend
 * (`Board.role`, `CurrentUser.admin`).
 */
export abstract class Auth {
  /** True while a session with tokens exists (the guard asks this, not `user`). */
  abstract readonly authenticated: Signal<boolean>;
  /** The profile from the backend; null before sign-in or until it is loaded. */
  abstract readonly user: Signal<AuthUser | null>;

  /**
   * The guest, when this tab opened a share link for guests (guest mode, architecture S1);
   * null otherwise. In guest mode `token()` is the guest JWT, which only the few guest
   * operations of the API accept.
   */
  abstract readonly guest: Signal<GuestUser | null>;

  /** Redirects to the login page; `redirectPath` is where the user comes back to. */
  abstract login(redirectPath?: string): Promise<void>;
  /** Ends the session at the provider (end-session endpoint). */
  abstract logout(): Promise<void>;
  /** A valid access token (renewed when it expires within minValiditySeconds), or undefined. */
  abstract token(minValiditySeconds?: number): Promise<string | undefined>;
}
