import { Service, computed, effect, inject, signal } from '@angular/core';
import { HttpContext } from '@angular/common/http';
import { Router } from '@angular/router';
import {
  GrantRole,
  GuestSession as GuestSessionDto,
  ShareResourceKind,
  SharingService,
} from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ApiError } from '../util/api-error';
import { ERRORS_HANDLED_LOCALLY } from './error-interceptor';

/** Who the guest is, as far as the UI needs it. */
export interface GuestUser {
  /** The display name the server stored (sanitised, at most 64 characters). */
  readonly name: string;
  readonly role: GrantRole;
  /** What the link opens: one board or a folder (its boards). */
  readonly kind: ShareResourceKind;
  /** Id of that board or folder. */
  readonly id: string;
}

/** Why a guest session ended. */
export type GuestEndReason = 'limit' | 'revoked' | 'unauthorized';

/** Renew this long before the token expires. */
export const REFRESH_MARGIN_MS = 60_000;
/** A guest session ends 12 hours after the first exchange, whatever happens (S1.4). */
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
/** Wait after a failed renewal before the next attempt (network trouble, rate limit). */
const RETRY_MS = 15_000;

/**
 * The guest mode of the app (architecture S1): the state behind `Auth.guest`.
 *
 * Where the secrets live: the guest JWT (`accessToken`) and the link token (needed to renew the
 * session) are private fields of this service - MEMORY ONLY. Nothing goes to localStorage,
 * sessionStorage, a cookie, the URL or a log; a reload, `clear()` and the end of the session
 * drop both. The JWT is renewed with refreshGuestSession shortly before it expires (a timer,
 * and on demand in `token()`); 12 hours after the first exchange the session ends with a clear
 * message (`endedReason`) and the guest opens the link again.
 */
@Service()
export class GuestSession {
  private readonly sharingApi = inject(SharingService);
  private readonly router = inject(Router);

  private readonly info = signal<GuestUser | null>(null);
  /** The guest, or null when this browser tab is not in guest mode. */
  readonly user = this.info.asReadonly();
  readonly active = computed(() => this.info() !== null);
  /** Set when a guest session ended by itself; cleared by the next `start()`. */
  readonly endedReason = signal<GuestEndReason | undefined>(undefined);

  private accessToken: string | undefined;
  private linkToken: string | undefined;
  private expiresAt = 0;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;

  constructor() {
    // when the session ends under a guest page, the join page tells why
    effect(() => {
      if (this.endedReason() && this.router.url.startsWith('/s/')) {
        void this.router.navigate(['/s'], { replaceUrl: true });
      }
    });
  }

  /** Enters guest mode with the session of an exchange; `linkToken` is kept for the renewals. */
  start(session: GuestSessionDto, linkToken: string): void {
    this.clear();
    this.accessToken = session.accessToken;
    this.linkToken = linkToken;
    this.expiresAt = Date.parse(session.expiresAt);
    this.startedAt = Date.now();
    this.endedReason.set(undefined);
    this.info.set({ name: session.name, role: session.role, kind: session.kind, id: session.id });
    this.schedule();
  }

  /**
   * The guest JWT for a request, renewed first when it expires within a minute. The renewal's
   * own request asks while `refreshing` is set and gets the current token (it is still valid:
   * renewals start a minute early).
   */
  async token(): Promise<string | undefined> {
    if (this.accessToken && !this.refreshing && this.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      await this.refresh();
    }
    return this.accessToken;
  }

  /** Leaves guest mode and forgets every secret. */
  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.accessToken = undefined;
    this.linkToken = undefined;
    this.expiresAt = 0;
    this.info.set(null);
  }

  /** The session is over (12 h limit, link revoked, token refused): forget it and say why. */
  end(reason: GuestEndReason): void {
    this.clear();
    this.endedReason.set(reason);
  }

  private schedule(delayMs?: number): void {
    clearTimeout(this.timer);
    const renewIn = Math.max(5_000, this.expiresAt - Date.now() - REFRESH_MARGIN_MS);
    const limitIn = Math.max(0, this.startedAt + MAX_SESSION_MS - Date.now());
    this.timer = setTimeout(() => void this.refresh(), Math.min(delayMs ?? renewIn, limitIn));
  }

  private async refresh(): Promise<void> {
    const linkToken = this.linkToken;
    if (!linkToken || this.refreshing) {
      return;
    }
    if (Date.now() - this.startedAt >= MAX_SESSION_MS) {
      this.end('limit');
      return;
    }
    this.refreshing = true;
    try {
      const context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);
      const renewed = await firstValueFrom(
        this.sharingApi.refreshGuestSession({ shareRefresh: { token: linkToken } }, 'body', false, {
          context,
        }),
      );
      if (this.linkToken !== linkToken) {
        return; // left or restarted meanwhile
      }
      this.accessToken = renewed.accessToken;
      this.expiresAt = Date.parse(renewed.expiresAt);
      this.info.set({ name: renewed.name, role: renewed.role, kind: renewed.kind, id: renewed.id });
      this.schedule();
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      this.onRefreshFailed(error);
    } finally {
      this.refreshing = false;
    }
  }

  private onRefreshFailed(error: ApiError): void {
    if (error.status === 404) {
      this.end('revoked');
    } else if (error.status === 401 || error.status === 403) {
      // 'limit' is only the 12 h hard stop; a refused renewal means the token is no longer valid
      this.end('unauthorized');
    } else if (this.expiresAt <= Date.now()) {
      this.end('unauthorized');
    } else {
      // transient (network, 429, 5xx): the current token is still valid, try again soon
      this.schedule(RETRY_MS);
    }
  }
}
