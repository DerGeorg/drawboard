import { Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormField, form, maxLength, pattern, required } from '@angular/forms/signals';
import { GrantRole, Member, MemberPrincipalKind, UserSummary } from '@apps/drawboard-api';

import { debounced } from '../../../../util/debounced';
import { WithSpan } from '../../../../util/tracing';
import { Avatar } from '../../../shared/avatar/avatar';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { Icon } from '../../../shared/icon/icon';
import { LoadError } from '../../../shared/load-error/load-error';
import { RoleBadge } from '../../../shared/role-badge/role-badge';
import { LibraryFolders } from '../library-folders';
import { ShareActions } from '../share-actions';
import { ShareReads } from '../share-reads';
import { GRANT_ROLES, ShareKind } from '../share-target';

/** One line of the member list. */
interface PersonRow {
  readonly key: string;
  readonly kind: 'OWNER' | MemberPrincipalKind;
  readonly name: string;
  /** "@username" for people, "Group" for groups - never an email address. */
  readonly detail: string;
  readonly role: GrantRole | 'OWNER';
  readonly userId?: string;
  readonly group?: string;
  /** Id of the folder the grant is inherited from; such a grant is changed on that folder. */
  readonly inheritedFrom?: string;
}

/** Minimum length of a user search (the API refuses shorter texts). */
export const MIN_SEARCH_LENGTH = 2;
/** The pattern of a group name in the contract (GroupName parameter). */
const GROUP_PATTERN = /^[A-Za-z0-9._@:+-]([A-Za-z0-9._@:+ -]*[A-Za-z0-9._@:+-])?$/;

/**
 * The "People" tab of the share dialog: owner, users and groups with their roles, grants
 * inherited from folders marked "from folder …". The owner changes roles, removes grants and
 * adds people (typeahead on username/display name, at least 2 characters, debounced) or groups
 * by name; everyone else sees the list read-only. Email addresses never appear (S6.9).
 */
@Component({
  selector: 'drawboard-share-people',
  imports: [Avatar, FieldErrors, FormField, Icon, LoadError, RoleBadge],
  templateUrl: './share-people.html',
})
export class SharePeople {
  private readonly reads = inject(ShareReads);
  private readonly actions = inject(ShareActions);
  private readonly folders = inject(LibraryFolders);

  readonly kind = input.required<ShareKind>();
  readonly resourceId = input.required<string>();
  /** Only the owner manages sharing; others see the list. */
  readonly canManage = input(false);

  protected readonly roles = GRANT_ROLES;
  protected readonly newRole = signal<GrantRole>('VIEWER');
  protected readonly busy = signal(false);

  protected readonly members = rxResource({
    params: () => ({ kind: this.kind(), id: this.resourceId() }),
    stream: ({ params }) => this.reads.members(params.kind, params.id),
  });

  protected readonly rows = computed<PersonRow[]>(() => {
    if (!this.members.hasValue()) {
      return [];
    }
    const { owner, items } = this.members.value();
    const ownerRow: PersonRow = {
      key: 'owner',
      kind: 'OWNER',
      name: owner.displayName,
      detail: owner.username ? `@${owner.username}` : '',
      role: 'OWNER',
    };
    const rest = items
      .map<PersonRow>((member) => this.toRow(member))
      .sort(
        (a, b) =>
          Number(a.inheritedFrom !== undefined) - Number(b.inheritedFrom !== undefined) ||
          a.name.localeCompare(b.name),
      );
    return [ownerRow, ...rest];
  });

  // --- find people ---------------------------------------------------------------------
  private readonly searchModel = signal({ query: '' });
  protected readonly searchForm = form(this.searchModel);
  private readonly debouncedQuery = debounced(() => this.searchModel().query.trim(), 300);

  protected readonly results = rxResource({
    params: () =>
      this.canManage() && this.debouncedQuery().length >= MIN_SEARCH_LENGTH
        ? { q: this.debouncedQuery() }
        : undefined,
    stream: ({ params }) => this.reads.searchUsers(params.q),
  });
  /** The hits that are not yet on the list (direct grants) - the owner cannot be added. */
  protected readonly candidates = computed<UserSummary[]>(() => {
    if (!this.results.hasValue()) {
      return [];
    }
    const taken = new Set(
      this.rows()
        .filter((r) => r.userId && r.inheritedFrom === undefined)
        .map((r) => r.userId),
    );
    return this.results.value().items.filter((u) => !taken.has(u.id));
  });
  protected readonly searching = computed(
    () => this.searchModel().query.trim().length >= MIN_SEARCH_LENGTH,
  );

  // --- add a group ---------------------------------------------------------------------
  private readonly groupModel = signal({ name: '' });
  protected readonly groupForm = form(this.groupModel, (path) => {
    required(path.name, { message: 'Enter the name of the group.' });
    maxLength(path.name, 128, { message: 'At most 128 characters.' });
    pattern(path.name, GROUP_PATTERN, {
      message: 'Letters, digits and . _ @ : + - only (spaces inside are fine).',
    });
  });

  protected displayName(user: UserSummary): string {
    return user.displayName || user.username;
  }

  /** "from folder Work" - the name when it is one of the user's own folders. */
  protected inheritedFromText(row: PersonRow): string {
    const name = this.folders.byId(row.inheritedFrom)?.name;
    return name ? `from folder ${name}` : 'from a folder above';
  }

  protected roleLabel(role: GrantRole | 'OWNER'): string {
    return GRANT_ROLES.find((r) => r.value === role)?.label ?? 'Owner';
  }

  protected selectedRole(event: Event): GrantRole {
    return (event.target as HTMLSelectElement).value as GrantRole;
  }

  @WithSpan('SharePeople.setNewRole')
  protected setNewRole(event: Event): void {
    this.newRole.set(this.selectedRole(event));
  }

  @WithSpan('SharePeople.addUser')
  protected async addUser(user: UserSummary): Promise<void> {
    if (
      await this.run(() =>
        this.actions.setUserRole(this.kind(), this.resourceId(), user.id, this.newRole()),
      )
    ) {
      this.searchModel.set({ query: '' });
    }
  }

  @WithSpan('SharePeople.addGroup')
  protected async addGroup(): Promise<void> {
    const group = this.groupModel().name.trim();
    if (this.groupForm().invalid() || group === '') {
      this.groupForm.name().markAsTouched();
      return;
    }
    if (
      await this.run(() =>
        this.actions.setGroupRole(this.kind(), this.resourceId(), group, this.newRole()),
      )
    ) {
      this.groupModel.set({ name: '' });
    }
  }

  @WithSpan('SharePeople.changeRole')
  protected async changeRole(row: PersonRow, event: Event): Promise<void> {
    const role = this.selectedRole(event);
    await this.run(() =>
      row.group
        ? this.actions.setGroupRole(this.kind(), this.resourceId(), row.group, role)
        : this.actions.setUserRole(this.kind(), this.resourceId(), row.userId as string, role),
    );
  }

  @WithSpan('SharePeople.remove')
  protected async remove(row: PersonRow): Promise<void> {
    await this.run(() =>
      row.group
        ? this.actions.removeGroup(this.kind(), this.resourceId(), row.group)
        : this.actions.removeUser(this.kind(), this.resourceId(), row.userId as string),
    );
  }

  /** Runs a command, then reloads the list; true when the command worked. */
  private async run(command: () => Promise<boolean>): Promise<boolean> {
    this.busy.set(true);
    try {
      const done = await command();
      this.members.reload();
      return done;
    } finally {
      this.busy.set(false);
    }
  }

  private toRow(member: Member): PersonRow {
    const { principal } = member;
    const isGroup = principal.kind === 'GROUP';
    return {
      key: `${principal.kind}-${principal.userId ?? principal.group}-${member.inheritedFrom ?? 'direct'}`,
      kind: principal.kind,
      name: principal.displayName,
      detail: isGroup ? 'Group' : principal.username ? `@${principal.username}` : '',
      role: member.role,
      userId: principal.userId,
      group: principal.group,
      inheritedFrom: member.inheritedFrom,
    };
  }
}
