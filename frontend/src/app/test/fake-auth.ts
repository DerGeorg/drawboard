import { Provider, signal } from '@angular/core';

import { Auth, AuthUser } from '../services/auth';
import type { GuestUser } from '../services/guest-session';

/** Auth for tests: sign in directly; records login/logout calls. */
export class FakeAuth extends Auth {
  private readonly session = signal(false);
  private readonly profile = signal<AuthUser | null>(null);
  readonly authenticated = this.session.asReadonly();
  readonly user = this.profile.asReadonly();
  private readonly guestUser = signal<GuestUser | null>(null);
  readonly guest = this.guestUser.asReadonly();

  accessToken: string | undefined = 'test-token';
  readonly loginCalls: (string | undefined)[] = [];
  logoutCalls = 0;

  signIn(username: string, displayName = username, admin = false, guestLinksEnabled = false): void {
    this.profile.set({ id: `id-${username}`, username, displayName, admin, guestLinksEnabled });
    this.session.set(true);
  }

  /** Guest mode: a guest with a token but no OIDC session. */
  signInAsGuest(guest: GuestUser): void {
    this.guestUser.set(guest);
  }

  /** Tokens but no profile (yet) - e.g. while /api/users/me is still loading. */
  signInWithoutProfile(): void {
    this.session.set(true);
  }

  login(redirectPath?: string): Promise<void> {
    this.loginCalls.push(redirectPath);
    return Promise.resolve();
  }

  logout(): Promise<void> {
    this.logoutCalls++;
    this.session.set(false);
    this.profile.set(null);
    return Promise.resolve();
  }

  token(): Promise<string | undefined> {
    return Promise.resolve(this.session() || this.guestUser() ? this.accessToken : undefined);
  }
}

/** Provides a FakeAuth as Auth; returns it so the test can steer it. */
export function provideFakeAuth(auth = new FakeAuth()): { auth: FakeAuth; providers: Provider[] } {
  return { auth, providers: [{ provide: Auth, useValue: auth }] };
}

/** Shortcut: alice, a regular user. */
export function signedInAsAlice(): { auth: FakeAuth; providers: Provider[] } {
  const fake = provideFakeAuth();
  fake.auth.signIn('alice', 'Alice Admin');
  return fake;
}

/** Shortcut: bob, a regular user. */
export function signedInAsBob(): { auth: FakeAuth; providers: Provider[] } {
  const fake = provideFakeAuth();
  fake.auth.signIn('bob', 'Bob Builder');
  return fake;
}
