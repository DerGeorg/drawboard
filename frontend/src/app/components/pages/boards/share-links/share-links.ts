import { LowerCasePipe } from '@angular/common';
import { HttpContext } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  FieldTree,
  FormField,
  FormRoot,
  TreeValidationResult,
  form,
  validate,
} from '@angular/forms/signals';
import { CreatedShareLink, GrantRole, ShareAudience, ShareLink } from '@apps/drawboard-api';

import { Auth } from '../../../../services/auth';
import { FIELD_ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { violationsToFieldErrors } from '../../../../util/violations';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { Icon } from '../../../shared/icon/icon';
import { LoadError } from '../../../shared/load-error/load-error';
import { ShareActions } from '../share-actions';
import { ShareReads } from '../share-reads';
import { GRANT_ROLES, ShareKind } from '../share-target';

interface LinkDraft {
  audience: ShareAudience;
  role: GrantRole;
  /** `datetime-local` value ("2026-12-24T18:00") or empty = no expiry. */
  expiresAt: string;
  /** Empty = no password. */
  password: string;
}

const EMPTY_DRAFT: LinkDraft = {
  audience: 'SIGNED_IN',
  role: 'VIEWER',
  expiresAt: '',
  password: '',
};

/** The password rules of the contract (NewShareLink.password). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

type LinkState = 'Active' | 'Expired' | 'Revoked';

/**
 * The "Links" tab of the share dialog (owner only): create a link (audience, role, optional
 * expiry, optional password), copy the URL, see the existing links and revoke them.
 *
 * The URL of a new link carries the token and is shown ONCE (the server keeps only a hash): it
 * lives in a component signal, is never logged or stored, and is gone when the owner clicks
 * Done, creates another link or closes the dialog. "Guests without account" is offered only
 * when `CurrentUser.guestLinksEnabled` is true.
 */
@Component({
  selector: 'drawboard-share-links',
  imports: [FieldErrors, FormField, FormRoot, Icon, LoadError, LowerCasePipe],
  templateUrl: './share-links.html',
})
export class ShareLinks {
  private readonly reads = inject(ShareReads);
  private readonly actions = inject(ShareActions);
  private readonly auth = inject(Auth);

  readonly kind = input.required<ShareKind>();
  readonly resourceId = input.required<string>();

  protected readonly roles = GRANT_ROLES;
  protected readonly guestLinksEnabled = computed(
    () => this.auth.user()?.guestLinksEnabled === true,
  );
  /** The link just created, with its URL - shown once. */
  protected readonly created = signal<CreatedShareLink | undefined>(undefined);
  protected readonly copied = signal(false);
  protected readonly revoking = signal<string | undefined>(undefined);
  protected readonly busy = signal(false);

  protected readonly links = rxResource({
    params: () => ({ kind: this.kind(), id: this.resourceId() }),
    stream: ({ params }) => this.reads.links(params.kind, params.id),
  });
  protected readonly items = computed<ShareLink[]>(() =>
    this.links.hasValue() ? this.links.value().items : [],
  );

  private readonly draft = signal<LinkDraft>({ ...EMPTY_DRAFT });
  protected readonly linkForm = form(
    this.draft,
    (path) => {
      validate(path.password, ({ value }) =>
        value() !== '' && (value().length < PASSWORD_MIN || value().length > PASSWORD_MAX)
          ? {
              kind: 'passwordLength',
              message: `Between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`,
            }
          : undefined,
      );
      validate(path.expiresAt, ({ value }) =>
        value() !== '' && !(Date.parse(value()) > Date.now())
          ? { kind: 'expiryInPast', message: 'The expiry must be in the future.' }
          : undefined,
      );
    },
    { submission: { action: (field) => this.create(field) } },
  );

  protected state(link: ShareLink): LinkState {
    if (link.revokedAt) {
      return 'Revoked';
    }
    return link.expiresAt && Date.parse(link.expiresAt) <= Date.now() ? 'Expired' : 'Active';
  }

  protected roleLabel(role: GrantRole): string {
    return GRANT_ROLES.find((r) => r.value === role)?.label ?? role;
  }

  protected audienceLabel(audience: ShareAudience): string {
    return audience === 'GUESTS' ? 'Guests without account' : 'Anyone signed in';
  }

  protected expiry(link: ShareLink): string {
    return link.expiresAt
      ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(link.expiresAt),
        )
      : 'Never';
  }

  @WithSpan('ShareLinks.setAudience')
  protected setAudience(event: Event): void {
    this.draft.update((d) => ({
      ...d,
      audience: (event.target as HTMLInputElement).value as ShareAudience,
    }));
  }

  @WithSpan('ShareLinks.setRole')
  protected setRole(event: Event): void {
    this.draft.update((d) => ({
      ...d,
      role: (event.target as HTMLSelectElement).value as GrantRole,
    }));
  }

  /** The submission action: creates the link, shows its URL once, reloads the list. */
  @WithSpan('ShareLinks.create')
  private async create(field: FieldTree<LinkDraft>): Promise<TreeValidationResult> {
    const value = field().value();
    const context = new HttpContext().set(FIELD_ERRORS_HANDLED_LOCALLY, true);
    this.created.set(undefined);
    this.copied.set(false);
    try {
      // started before the first await: ShareActions' span becomes a child of this one
      const created = await this.actions.createLink(
        this.kind(),
        this.resourceId(),
        {
          audience: value.audience,
          role: value.role,
          expiresAt: value.expiresAt ? new Date(value.expiresAt).toISOString() : undefined,
          password: value.password === '' ? undefined : value.password,
        },
        context,
      );
      this.created.set(created);
      this.draft.set({ ...EMPTY_DRAFT, audience: value.audience, role: value.role });
      this.links.reload();
      return undefined;
    } catch (error) {
      if (error instanceof ApiError) {
        return violationsToFieldErrors(field, error.violations);
      }
      throw error;
    }
  }

  @WithSpan('ShareLinks.copy')
  protected async copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
    } catch {
      // no clipboard permission: the URL stays selectable in its field
      this.copied.set(false);
    }
  }

  @WithSpan('ShareLinks.selectUrl')
  protected selectUrl(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  @WithSpan('ShareLinks.done')
  protected done(): void {
    this.created.set(undefined);
    this.copied.set(false);
  }

  @WithSpan('ShareLinks.askRevoke')
  protected askRevoke(link: ShareLink): void {
    this.revoking.set(link.id);
  }

  @WithSpan('ShareLinks.cancelRevoke')
  protected cancelRevoke(): void {
    this.revoking.set(undefined);
  }

  @WithSpan('ShareLinks.revoke')
  protected async revoke(link: ShareLink): Promise<void> {
    this.busy.set(true);
    try {
      if (await this.actions.revokeLink(link.id)) {
        this.links.reload();
      }
    } finally {
      this.busy.set(false);
      this.revoking.set(undefined);
    }
  }
}
