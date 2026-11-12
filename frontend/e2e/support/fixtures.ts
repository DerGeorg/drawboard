import { APIRequestContext, test as base, request } from '@playwright/test';

import { TestUser, backendUrl, idp, users } from './users';

export interface Board {
  id: string;
  title: string;
  role: string;
  version: number;
}

/** Access token of a test user (password grant of the dev client). */
export async function tokenFor(user: TestUser): Promise<string> {
  const context = await request.newContext();
  try {
    const response = await context.post(
      `${idp.url}/realms/${idp.realm}/protocol/openid-connect/token`,
      {
        form: {
          grant_type: 'password',
          client_id: idp.clientId,
          client_secret: idp.clientSecret,
          username: user.name,
          password: user.password,
        },
      },
    );
    if (!response.ok()) {
      throw new Error(`token for ${user.name}: ${response.status()} ${await response.text()}`);
    }
    return ((await response.json()) as { access_token: string }).access_token;
  } finally {
    await context.dispose();
  }
}

/**
 * Seeds and cleans up test data through the backend API - never through the UI. API calls send
 * a readable X-Request-Id (e2e-…), so they are easy to find in Loki, Tempo and the audit log.
 */
export class BoardApi {
  private readonly created = new Set<string>();

  constructor(private readonly api: APIRequestContext) {}

  async create(title: string): Promise<Board> {
    const response = await this.api.post('/api/boards', {
      data: { title },
      headers: { 'X-Request-Id': `e2e-seed-${Date.now().toString(36)}` },
    });
    if (response.status() !== 201) {
      throw new Error(`seeding "${title}" failed: ${response.status()} ${await response.text()}`);
    }
    const board = (await response.json()) as Board;
    this.created.add(board.id);
    return board;
  }

  /** The board, or undefined when the backend answers 404. */
  async find(id: string): Promise<Board | undefined> {
    const response = await this.api.get(`/api/boards/${id}`);
    return response.status() === 404 ? undefined : ((await response.json()) as Board);
  }

  /** Also delete a board that was created through the UI. */
  track(id: string): void {
    this.created.add(id);
  }

  async cleanUp(): Promise<void> {
    for (const id of this.created) {
      await this.api.delete(`/api/boards/${id}`);
    }
  }
}

/** Unique, recognisable titles: parallel workers and other people's data never collide. */
export function uniqueTitle(label: string): string {
  return `e2e ${label} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const test = base.extend<{ asAlice: BoardApi }>({
  asAlice: async ({}, use) => {
    const api = await request.newContext({
      baseURL: backendUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${await tokenFor(users.alice)}` },
    });
    const boards = new BoardApi(api);
    await use(boards);
    await boards.cleanUp();
    await api.dispose();
  },
});

export { expect } from '@playwright/test';
