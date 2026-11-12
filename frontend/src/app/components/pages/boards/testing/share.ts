import { GrantRole, Member, MemberList, MemberPrincipal, ShareLink } from '@apps/drawboard-api';

export const BOB: MemberPrincipal = {
  kind: 'USER',
  userId: 'id-bob',
  displayName: 'Bob Builder',
  username: 'bob',
};

export const STAFF: MemberPrincipal = { kind: 'GROUP', group: 'staff', displayName: 'staff' };

export function aMember(
  principal: MemberPrincipal = BOB,
  role: GrantRole = 'EDITOR',
  inheritedFrom?: string,
): Member {
  return { principal, role, inheritedFrom };
}

export function aMemberList(items: Member[] = []): MemberList {
  return {
    owner: { kind: 'USER', userId: 'id-alice', displayName: 'Alice Admin', username: 'alice' },
    items,
  };
}

export function aShareLink(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: 'link-1',
    role: 'VIEWER',
    audience: 'SIGNED_IN',
    expiresAt: null,
    passwordProtected: false,
    createdAt: '2026-11-01T10:00:00Z',
    revokedAt: null,
    useCount: 0,
    ...overrides,
  };
}
