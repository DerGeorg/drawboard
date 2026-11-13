import { Board, BoardPage, BoardRole, CurrentUser, Folder } from '@apps/drawboard-api';

import { Problem } from '../util/api-error';

// Stable ids: readable failures, predictable URLs.
export const SPRINT_BOARD_ID = '01929a4e-0000-7000-8000-000000000001';
export const RETRO_BOARD_ID = '01929a4e-0000-7000-8000-000000000002';
export const WORK_FOLDER_ID = '01929a4e-0000-7000-8000-0000000000f1';
export const TEAM_FOLDER_ID = '01929a4e-0000-7000-8000-0000000000f2';

/** Builder with defaults: override only what the test is about. */
export function aBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: SPRINT_BOARD_ID,
    title: 'Sprint planning',
    ownerId: 'id-alice',
    folderId: null,
    role: BoardRole.OWNER,
    template: false,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-02T11:30:00Z',
    version: 0,
    ...overrides,
  };
}

export function aFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: WORK_FOLDER_ID,
    name: 'Work',
    ownerId: 'id-alice',
    parentId: null,
    role: BoardRole.OWNER,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-02T11:30:00Z',
    version: 0,
    ...overrides,
  };
}

export function aBoardPage(boards: Board[] = [aBoard()], number = 0, totalPages = 1): BoardPage {
  return {
    items: boards,
    page: { number, size: 10, totalElements: boards.length, totalPages },
  };
}

export function aCurrentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'id-alice',
    username: 'alice',
    displayName: 'Alice Admin',
    email: 'alice@example.test',
    admin: false,
    guestLinksEnabled: false,
    ...overrides,
  };
}

/** problem+json body (ErrorModel) of the backend. */
export function aProblem(overrides: Partial<Problem> = {}): Problem {
  return {
    code: 'INTERNAL_ERROR',
    status: 500,
    title: 'Internal Server Error',
    timestamp: '2026-11-02T10:00:00Z',
    requestId: 'req-test',
    ...overrides,
  };
}
