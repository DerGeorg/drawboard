import { Page, Route, expect, test } from '@playwright/test';

/**
 * Guests in the real app, without a backend: every `/api` call is answered here, and every call
 * the guest UI makes is checked against the guest allowlist of the contract (S1.8, as extended
 * for planning poker in the M4 contract review). A guest UI that tried more would fail here
 * long before the backend's route table refuses it. The collaboration socket is not served,
 * so the board stays offline and local.
 */
const BOARD = '0192bbbb-0000-7000-8000-00000000b0a1';
const ROUND = '0192aaaa-0000-7000-8000-000000000001';
const TOKEN = 'A'.repeat(43);
const B = `/api/boards/${BOARD}`;

type Role = 'VIEWER' | 'COMMENTER' | 'EDITOR';

/** What a guest may call (method, path, and for listPokerRounds only state=OPEN). */
const ALLOWLIST: readonly {
  method: string;
  path: RegExp;
  query?: (q: URLSearchParams) => boolean;
}[] = [
  { method: 'POST', path: /^\/api\/shares\/exchange$/ },
  { method: 'POST', path: /^\/api\/shares\/refresh$/ },
  { method: 'GET', path: /^\/api\/boards\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/boards$/, query: (q) => q.has('folderId') },
  { method: 'POST', path: /^\/api\/boards\/[^/]+\/collab-ticket$/ },
  { method: 'GET', path: /^\/api\/boards\/[^/]+\/files$/ },
  { method: 'GET', path: /^\/api\/boards\/[^/]+\/files\/urls$/ },
  { method: 'GET', path: /^\/api\/boards\/[^/]+\/files\/[^/]+$/ },
  { method: 'GET', path: /^\/api\/plugins$/ },
  { method: 'GET', path: /^\/api\/boards\/[^/]+\/plugin-storage\/[^/]+$/ },
  {
    method: 'GET',
    path: /^\/api\/boards\/[^/]+\/poker-rounds$/,
    query: (q) => (q.get('state') ?? 'OPEN') === 'OPEN',
  },
  { method: 'GET', path: /^\/api\/boards\/[^/]+\/poker-rounds\/[^/]+$/ },
  { method: 'PUT', path: /^\/api\/boards\/[^/]+\/poker-rounds\/[^/]+\/vote$/ },
];

/** Poker operations a VIEWER-link guest must never call (403 on every one, S1.8 M4). */
const POKER = /\/poker-rounds/;

function allowed(method: string, url: URL): boolean {
  return ALLOWLIST.some(
    (a) =>
      a.method === method && a.path.test(url.pathname) && (a.query?.(url.searchParams) ?? true),
  );
}

interface Api {
  calls: string[];
  /** The story card a listed round belongs to (set by the test once the card exists). */
  storyId?: string;
  /** List and serve the round as a quick round (no story card, contract 2.0.0). */
  quick?: boolean;
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function round(storyId: string | undefined, version = 1, voted = false) {
  return {
    id: ROUND,
    ...(storyId === undefined ? {} : { storyBlockId: storyId }),
    title: storyId === undefined ? 'Quick round' : 'Login',
    deck: { kind: 'TSHIRT', values: ['XS', 'S', 'M', 'L', 'XL', '?'] },
    state: 'OPEN',
    facilitatorName: 'Alice Admin',
    createdAt: '2026-11-10T08:00:00Z',
    version,
    participants: [{ displayName: 'Gina', guest: true, voted }],
  };
}

async function mockApi(page: Page, role: Role): Promise<Api> {
  const api: Api = { calls: [] };
  let version = 1;
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    api.calls.push(`${request.method()} ${url.pathname}${url.search}`);
    const path = url.pathname;
    if (path === '/api/shares/exchange') {
      return json(route, {
        kind: 'BOARD',
        id: BOARD,
        role,
        guestSession: {
          accessToken: 'guest-token',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          kind: 'BOARD',
          id: BOARD,
          role,
          name: 'Gina',
        },
      });
    }
    if (path === B) {
      return json(route, {
        id: BOARD,
        title: 'Sprint',
        ownerId: 'id-alice',
        folderId: null,
        role,
        createdAt: '2026-11-01T10:00:00Z',
        updatedAt: '2026-11-01T10:00:00Z',
        version: 0,
      });
    }
    if (path === '/api/plugins') {
      return json(route, { items: [] });
    }
    if (path === `${B}/poker-rounds`) {
      if (api.quick) {
        return json(route, { items: [round(undefined)] });
      }
      return json(route, { items: api.storyId ? [round(api.storyId)] : [] });
    }
    if (path === `${B}/poker-rounds/${ROUND}`) {
      const storyId = api.quick ? undefined : (api.storyId ?? 'none');
      return json(route, round(storyId, version, version > 1));
    }
    if (path === `${B}/poker-rounds/${ROUND}/vote` && request.method() === 'PUT') {
      version = 2;
      return route.fulfill({ status: 204 });
    }
    // the collaboration ticket and everything else: unavailable (the board stays offline)
    return json(route, { code: 'BAD_GATEWAY', status: 502, title: 'Bad Gateway' }, 502);
  });
  return api;
}

async function openAsGuest(page: Page, role: Role): Promise<Api> {
  const api = await mockApi(page, role);
  await page.goto(`/s#${TOKEN}`);
  await expect(page, 'on the guest board').toHaveURL(new RegExp(`/s/b/${BOARD}$`), {
    timeout: 15_000,
  });
  await expect(page.getByTestId('canvas'), 'the board').toBeVisible();
  return api;
}

function forbidden(api: Api): string[] {
  return api.calls.filter((c) => {
    const [method, rest] = c.split(' ') as [string, string];
    return !allowed(method, new URL(rest, 'http://x'));
  });
}

test.describe('guest allowlist (S1.8)', () => {
  test('when a guest opens an edit link then the UI calls only allowlisted operations and never facilitates', async ({
    page,
  }) => {
    const api = await openAsGuest(page, 'EDITOR');

    await expect(page.getByRole('button', { name: 'Share' }), 'no sharing').toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload files' }), 'no upload').toHaveCount(0);

    // a story card on the (local) board; the server pairs a round with it
    await page.getByRole('button', { name: 'Story card' }).click();
    const card = page.locator('[data-block-type="core.story"]');
    await expect(card, 'story card').toHaveCount(1);
    api.storyId = (await card.getAttribute('data-block-id')) ?? undefined;
    await page.getByRole('button', { name: 'Close the story card' }).click();

    // the list is read again (throttled) and the card shows its open round
    const chip = page.getByRole('button', { name: 'Open the planning poker round of this story' });
    await expect(chip, 'estimating chip').toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('open-rounds'), 'indicator').toHaveText(/1 open estimation/);
    await chip.click();

    const dialog = page.getByTestId('poker-dialog');
    await expect(dialog.getByRole('button', { name: 'M', exact: true }), 'cards').toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Reveal' }), 'no reveal').toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Cancel round' }), 'no cancel').toHaveCount(0);
    await dialog.getByRole('button', { name: 'M', exact: true }).click();
    await expect(dialog.getByTestId('my-vote'), 'voted').toContainText('You voted M');

    expect(forbidden(api), 'only allowlisted calls').toEqual([]);
    expect(
      api.calls.filter((c) => /^POST .*poker-rounds/.test(c)),
      'never create, reveal or cancel',
    ).toEqual([]);
    expect(api.calls, 'the vote went out').toContain(`PUT ${B}/poker-rounds/${ROUND}/vote`);
  });

  test('when a guest on a comment link opens a quick round from the pill then it votes with allowlisted calls only', async ({
    page,
  }) => {
    const api = await mockApi(page, 'COMMENTER');
    api.quick = true;
    await page.goto(`/s#${TOKEN}`);
    await expect(page, 'on the guest board').toHaveURL(new RegExp(`/s/b/${BOARD}$`), {
      timeout: 15_000,
    });

    const pill = page.getByTestId('open-rounds');
    await expect(pill, 'indicator').toHaveText(/1 open estimation/, { timeout: 15_000 });
    await pill.click();
    await expect(
      page.getByTestId('start-quick-round'),
      'a guest never starts a quick round',
    ).toHaveCount(0);
    await page.getByRole('button', { name: /Quick round/ }).click();

    const dialog = page.getByTestId('poker-dialog');
    await expect(dialog.getByTestId('quick-marker'), 'quick mode').toBeVisible();
    await dialog.getByRole('button', { name: 'M', exact: true }).click();
    await expect(dialog.getByTestId('my-vote'), 'voted').toContainText('You voted M');
    await expect(dialog.getByRole('button', { name: 'Reveal' }), 'no reveal').toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Cancel round' }), 'no cancel').toHaveCount(0);

    expect(forbidden(api), 'only allowlisted calls').toEqual([]);
    expect(
      api.calls.filter((c) => /^POST .*poker-rounds/.test(c)),
      'never create, reveal or cancel',
    ).toEqual([]);
    expect(api.calls, 'the vote went out').toContain(`PUT ${B}/poker-rounds/${ROUND}/vote`);
  });

  test('when a guest opens a view link then no poker call is made at all', async ({ page }) => {
    const api = await openAsGuest(page, 'VIEWER');

    await expect(page.getByRole('button', { name: 'Story card' }), 'no drawing').toHaveCount(0);
    // the page is up when it read the enabled plugins - poker would have been asked by then
    await expect
      .poll(() => api.calls.some((c) => c.startsWith('GET /api/plugins')), { message: 'loaded' })
      .toBe(true);

    expect(forbidden(api), 'only allowlisted calls').toEqual([]);
    expect(
      api.calls.filter((c) => POKER.test(c)),
      'no poker for VIEWER links',
    ).toEqual([]);
  });

  test('when a guest opens a comment link then open rounds are listed with state OPEN only', async ({
    page,
  }) => {
    const api = await openAsGuest(page, 'COMMENTER');

    await expect
      .poll(() => api.calls.filter((c) => POKER.test(c)), { message: 'the list' })
      .toEqual([`GET ${B}/poker-rounds?state=OPEN`]);
    await expect(page.getByRole('button', { name: 'Story card' }), 'read-only').toHaveCount(0);
    expect(forbidden(api), 'only allowlisted calls').toEqual([]);
  });
});
