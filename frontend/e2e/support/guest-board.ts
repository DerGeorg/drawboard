import { Page, expect } from '@playwright/test';

import { MockCollabSocket } from './collab-socket';

/**
 * The board of a guest with an edit link - the one board page that opens without a login. Every
 * /api call is mocked; without `collab` the collaboration socket is not served, so the board
 * stays local; with it the socket is answered in the browser by that `MockCollabSocket`.
 */
export const BOARD = '0192bbbb-0000-7000-8000-00000000b0a2';

export async function openGuestBoard(
  page: Page,
  options: { collab?: MockCollabSocket } = {},
): Promise<void> {
  if (options.collab) {
    await options.collab.install(page);
  }
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/shares/exchange') {
      return json({
        kind: 'BOARD',
        id: BOARD,
        role: 'EDITOR',
        guestSession: {
          accessToken: 'guest-token',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          kind: 'BOARD',
          id: BOARD,
          role: 'EDITOR',
          name: 'Gina',
        },
      });
    }
    if (path === `/api/boards/${BOARD}`) {
      return json({
        id: BOARD,
        title: 'Sprint',
        ownerId: 'id-alice',
        folderId: null,
        role: 'EDITOR',
        createdAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-01T10:00:00Z',
        version: 0,
      });
    }
    if (options.collab && path === `/api/boards/${BOARD}/collab-ticket`) {
      return json({
        ticket: 'T'.repeat(43),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        url: `/api/boards/${BOARD}/collab`,
        protocol: 'drawboard.v1',
      });
    }
    if (path === '/api/plugins' || path.endsWith('/poker-rounds')) {
      return json({ items: [] });
    }
    return route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/s#${'K'.repeat(43)}`);
  await expect(page, 'on the board').toHaveURL(new RegExp(`/s/b/${BOARD}$`), { timeout: 15_000 });
}
