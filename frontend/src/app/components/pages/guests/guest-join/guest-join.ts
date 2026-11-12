import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, form, maxLength, pattern, required } from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ShareAccess } from '@apps/drawboard-api';

import { Auth } from '../../../../services/auth';
import { GuestEndReason, GuestSession } from '../../../../services/guest-session';
import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { DgLogo } from '../../../shared/dg-logo/dg-logo';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { GuestActions } from '../guest-actions';
import { GuestMadeWith } from '../guest-made-with/guest-made-with';

/** A link token: 256 bit, base64url without padding (43 characters). */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** What the page shows. */
type JoinView =
  | { kind: 'working' }
  | { kind: 'noLink' }
  | { kind: 'invalid' }
  | { kind: 'password'; wrong: boolean }
  | { kind: 'name'; rejected: boolean }
  | { kind: 'login' }
  | { kind: 'rateLimited'; seconds: number | undefined }
  | { kind: 'failed'; requestId: string | undefined };

/** Text per reason why a guest session ended. */
const ENDED_TEXT: Readonly<Record<GuestEndReason, string>> = {
  limit: 'Your guest session ended after 12 hours. Open the link again to continue.',
  revoked: 'This link was revoked or has expired. Ask the owner for a new one.',
  unauthorized: 'Your guest session is no longer valid. Open the link again to continue.',
};

/**
 * /s - opens a share link (architecture S1, S5.7). Public: no login needed.
 *
 *  1. The token is read from the router's fragment (`/s#<token>`; ActivatedRoute.fragment covers
 *     the first load and a link pasted into the address bar while this page is open, both are
 *     router navigations). The fragment is removed from the address bar (history.replaceState)
 *     at once, and then from the router's own URL by a navigation to the same route without
 *     it, so it is not in the history, `router.url`, a bookmark, a screenshot or a referrer.
 *     The token lives in a private field of this component and nowhere else - never in
 *     localStorage, sessionStorage, a cookie, a log, a span or the router state.
 *  2. exchangeShareToken answers: a signed-in visitor goes to the board or folder; an
 *     anonymous one on a guest link becomes a guest (GuestSession keeps the token and the link
 *     token in memory) after choosing a name; passwords are asked when needed.
 *  3. A link for signed-in users opened while signed out needs a login. The page does NOT keep
 *     the token across the redirect to the identity provider (the only places would be
 *     sessionStorage or the OIDC `state`, both readable by scripts and left behind if the
 *     login is abandoned): it asks to sign in and to open the link again afterwards. Safer,
 *     one more click.
 */
@Component({
  selector: 'drawboard-guest-join',
  imports: [DgLogo, FieldErrors, FormField, GuestMadeWith, RouterLink],
  templateUrl: './guest-join.html',
})
export class GuestJoin {
  private readonly actions = inject(GuestActions);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly guestSession = inject(GuestSession);

  /** The link token and password: in memory until the exchange is over. */
  private token: string | undefined;
  private password: string | undefined;

  protected readonly view = signal<JoinView>({ kind: 'working' });
  protected readonly signedIn = this.auth.authenticated;
  protected readonly endedText = computed(() => {
    const reason = this.guestSession.endedReason();
    return reason ? ENDED_TEXT[reason] : undefined;
  });

  protected readonly passwordWrong = computed(() => {
    const view = this.view();
    return view.kind === 'password' && view.wrong;
  });
  protected readonly nameRejected = computed(() => {
    const view = this.view();
    return view.kind === 'name' && view.rejected;
  });
  protected readonly waitSeconds = computed(() => {
    const view = this.view();
    return view.kind === 'rateLimited' ? view.seconds : undefined;
  });
  protected readonly failedRequestId = computed(() => {
    const view = this.view();
    return view.kind === 'failed' ? view.requestId : undefined;
  });

  private readonly passwordModel = signal({ password: '' });
  protected readonly passwordForm = form(this.passwordModel, (path) => {
    required(path.password, { message: 'Enter the password.' });
  });
  private readonly nameModel = signal({ name: '' });
  protected readonly nameForm = form(this.nameModel, (path) => {
    required(path.name, { message: 'Enter a name.' });
    pattern(path.name, /\S/, { message: 'Enter a name.' });
    maxLength(path.name, 64, { message: 'At most 64 characters.' });
  });

  constructor() {
    let first = true;
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => {
      // only a fragment starts an open: the navigation that clears it (fragment null) must not
      // reset the page to "no link"
      if (fragment !== null && fragment !== '') {
        this.readLink(fragment);
      } else if (first) {
        this.readLink(undefined);
      }
      first = false;
    });
  }

  /** Takes the token from the fragment, removes it from the URL and opens the link. */
  private readLink(fragment: string | undefined): void {
    this.forget();
    this.nameModel.set({ name: '' });
    this.token = fragment;
    if (fragment !== undefined) {
      removeFragmentFromAddressBar();
      // the router still holds the fragment in its URL tree and `router.url`
      void this.router.navigate([], {
        relativeTo: this.route,
        replaceUrl: true,
        queryParamsHandling: 'preserve',
      });
    }
    if (this.token === undefined) {
      this.view.set({ kind: 'noLink' });
    } else if (!TOKEN_FORMAT.test(this.token)) {
      this.token = undefined;
      this.view.set({ kind: 'invalid' });
    } else {
      void this.open();
    }
  }

  @WithSpan('GuestJoin.open')
  private async open(guestName?: string): Promise<void> {
    const token = this.token;
    if (token === undefined) {
      return;
    }
    // a guest who opens another link drops the guest token first (the API refuses it otherwise)
    this.guestSession.clear();
    this.view.set({ kind: 'working' });
    try {
      // started before the first await: GuestActions' span becomes a child of this one
      const access = await this.actions.exchange(token, this.password, guestName);
      await this.succeed(access, token);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      this.fail(error, guestName !== undefined);
    }
  }

  private async succeed(access: ShareAccess, token: string): Promise<void> {
    this.forget();
    if (access.guestSession) {
      this.guestSession.start(access.guestSession, token);
      await this.router.navigate(['/s', access.kind === 'BOARD' ? 'b' : 'f', access.id], {
        replaceUrl: true,
      });
    } else if (access.kind === 'BOARD') {
      await this.router.navigate(['/boards', access.id], { replaceUrl: true });
    } else {
      await this.router.navigate(['/boards'], {
        queryParams: { view: 'shared', folder: access.id },
        replaceUrl: true,
      });
    }
  }

  private fail(error: ApiError, nameWasSent: boolean): void {
    if (error.status === 404) {
      this.forget();
      this.view.set({ kind: 'invalid' });
    } else if (error.code === 'LIBRARY_SHARE_PASSWORD_REQUIRED') {
      this.view.set({ kind: 'password', wrong: false });
    } else if (error.code === 'LIBRARY_SHARE_PASSWORD_INVALID') {
      this.passwordModel.set({ password: '' });
      this.view.set({ kind: 'password', wrong: true });
    } else if (error.code === 'LIBRARY_SHARE_LOGIN_REQUIRED') {
      this.forget();
      this.view.set({ kind: 'login' });
    } else if (error.status === 400 && error.violations.some((v) => v.field === 'guestName')) {
      this.view.set({ kind: 'name', rejected: nameWasSent });
    } else if (error.status === 429) {
      const seconds = Number(error.response.headers.get('Retry-After'));
      this.view.set({
        kind: 'rateLimited',
        seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined,
      });
    } else {
      this.forget();
      this.view.set({ kind: 'failed', requestId: error.requestId });
    }
  }

  /** Drops the secrets of the exchange from memory. */
  private forget(): void {
    this.token = undefined;
    this.password = undefined;
    this.passwordModel.set({ password: '' });
  }

  @WithSpan('GuestJoin.submitPassword')
  protected submitPassword(event: Event): void {
    event.preventDefault();
    if (this.passwordForm().invalid()) {
      this.passwordForm.password().markAsTouched();
      return;
    }
    this.password = this.passwordModel().password;
    void this.open();
  }

  @WithSpan('GuestJoin.submitName')
  protected submitName(event: Event): void {
    event.preventDefault();
    if (this.nameForm().invalid()) {
      this.nameForm.name().markAsTouched();
      return;
    }
    void this.open(this.nameModel().name.trim());
  }

  @WithSpan('GuestJoin.retry')
  protected retry(): void {
    void this.open();
  }

  @WithSpan('GuestJoin.signIn')
  protected async signIn(): Promise<void> {
    await this.auth.login('/s');
  }
}

/** Removes the fragment from the address bar and the history entry; path and query stay. */
function removeFragmentFromAddressBar(): void {
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
}
