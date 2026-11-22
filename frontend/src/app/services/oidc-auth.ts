import { Service, computed, inject, signal } from '@angular/core';
import { UsersService } from '@apps/drawboard-api';
import { User } from 'oidc-client-ts';
import { firstValueFrom } from 'rxjs';

import { Auth, AuthUser } from './auth';
import { GuestSession } from './guest-session';
import { CALLBACK_PATH, NAVIGATE, OIDC_CLIENT } from './oidc-client';
import { RUNTIME_CONFIG } from './runtime-config';

/** What the login request carries through the provider and back. */
interface LoginState {
  readonly returnUrl: string;
}

/**
 * Auth on top of oidc-client-ts (client from OIDC_CLIENT, see config.ts). Tokens live in
 * memory only; renewal happens on demand in token(), no timers: with a refresh token if a
 * the provider issued one, else by a silent (prompt=none) request in a hidden iframe.
 *
 * start() runs once before routing (provideAppInitializer): it finishes a login redirect or
 * tries the silent sign-in, then loads the profile. Both fall back to "not signed in".
 */
@Service({ autoProvided: false })
export class OidcAuth extends Auth {
  private readonly client = inject(OIDC_CLIENT);
  private readonly usersApi = inject(UsersService);
  private readonly navigate = inject(NAVIGATE);
  private readonly guestSession = inject(GuestSession);
  private readonly config = inject(RUNTIME_CONFIG);

  /** The OIDC session (tokens); null = not signed in. */
  private readonly session = signal<User | null>(null);
  private readonly profile = signal<AuthUser | null>(null);
  private renewal: Promise<string | undefined> | undefined;

  readonly authenticated = computed(() => this.session() !== null);
  readonly user = this.profile.asReadonly();
  readonly guest = this.guestSession.user;

  /** Finishes the login redirect or tries the silent sign-in, then loads the profile. Never throws. */
  async start(): Promise<void> {
    await this.restoreSession();
    if (this.session()) {
      await this.loadProfile();
    }
  }

  async login(redirectPath?: string): Promise<void> {
    // never a fragment in the return URL: it may hold a link token
    const returnUrl = (
      redirectPath ?? `${window.location.pathname}${window.location.search}`
    ).split('#')[0];
    await this.client.signinRedirect({ state: { returnUrl } satisfies LoginState });
  }

  /**
   * Ends the session at the provider too - otherwise the next page load signs the user in again
   * silently (architecture S6.1, Authelia review). Providers with RP-initiated logout (Keycloak)
   * get signoutRedirect(); a provider whose discovery has no end_session_endpoint (Authelia) is
   * sent to its own logout page, which returns to the app (`rd`).
   */
  async logout(): Promise<void> {
    try {
      const endSession = await this.client.metadataService.getEndSessionEndpoint();
      if (endSession) {
        await this.client.signoutRedirect();
      } else {
        await this.client.removeUser();
        this.navigate(providerLogoutUrl(this.config.oidcIssuer, window.location.origin));
      }
    } catch (error) {
      // discovery or the provider unreachable: at least end the local session
      console.warn('Sign-out at the provider failed, ending the local session only.', error);
      await this.client.removeUser();
      this.navigate('/');
    } finally {
      this.session.set(null);
      this.profile.set(null);
    }
  }

  async token(minValiditySeconds = 30): Promise<string | undefined> {
    if (this.guestSession.active()) {
      return this.guestSession.token();
    }
    const user = this.session();
    if (!user) {
      return undefined;
    }
    if (user.expires_in === undefined || user.expires_in > minValiditySeconds) {
      return user.access_token;
    }
    // concurrent requests share one renewal
    this.renewal ??= this.renew().finally(() => (this.renewal = undefined));
    return this.renewal;
  }

  private async renew(): Promise<string | undefined> {
    try {
      const user = await this.client.signinSilent();
      this.session.set(user);
      if (!user) {
        this.profile.set(null);
      }
      return user?.access_token;
    } catch {
      // session over: the backend answers 401 and the error handler signs in again
      this.session.set(null);
      this.profile.set(null);
      return undefined;
    }
  }

  private async restoreSession(): Promise<void> {
    const onCallback = window.location.pathname === CALLBACK_PATH;
    try {
      if (onCallback) {
        const user = await this.client.signinRedirectCallback();
        this.session.set(user);
        window.history.replaceState(null, '', returnUrlOf(user.state));
      } else {
        this.session.set(await this.client.signinSilent());
      }
    } catch (error) {
      this.session.set(null);
      console.warn('Sign-in could not be restored, continuing signed out.', error);
      if (onCallback) {
        window.history.replaceState(null, '', '/');
      }
    }
  }

  private async loadProfile(): Promise<void> {
    try {
      const me = await firstValueFrom(this.usersApi.getCurrentUser());
      this.profile.set({
        id: me.id,
        username: me.username,
        displayName: me.displayName || me.username,
        admin: me.admin,
        guestLinksEnabled: me.guestLinksEnabled,
        gifsEnabled: me.gifsEnabled === true,
        theme: me.theme,
      });
    } catch {
      // already reported by the error interceptor (toast with request id)
      this.profile.set(null);
    }
  }
}

/** Only same-origin paths are valid return URLs - never an absolute one from the state. */
function returnUrlOf(state: unknown): string {
  const url = (state as Partial<LoginState> | undefined)?.returnUrl;
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

/**
 * The logout page of a provider without RP-initiated logout (Authelia: `<issuer>/logout?rd=`),
 * returning to the start page of this app.
 */
export function providerLogoutUrl(issuer: string, origin: string): string {
  return `${issuer.replace(/\/$/, '')}/logout?rd=${encodeURIComponent(`${origin}/`)}`;
}
