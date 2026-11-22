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
  // estimation sessions (E8): list (ACTIVE only - guests get 403 for CLOSED), get, join,
  // leave, placement, estimate; never create, start, advance, decide, finish, cancel
  {
    method: 'GET',
    path: /^\/api\/boards\/[^/]+\/estimation-sessions$/,
    query: (q) => (q.get('state') ?? 'ACTIVE') === 'ACTIVE',
  },
  { method: 'GET', path: /^\/api\/boards\/[^/]+\/estimation-sessions\/[^/]+$/ },
  { method: 'PUT', path: /^\/api\/boards\/[^/]+\/estimation-sessions\/[^/]+\/seats\/me$/ },
  { method: 'DELETE', path: /^\/api\/boards\/[^/]+\/estimation-sessions\/[^/]+\/seats\/me$/ },
  {
    method: 'PUT',
    path: /^\/api\/boards\/[^/]+\/estimation-sessions\/[^/]+\/items\/[^/]+\/(placement|estimate)$/,
  },
];

/** Poker operations a VIEWER-link guest must never call (403 on every one, S1.8 M4). */
const POKER = /\/poker-rounds/;
/** Estimation operations a VIEWER-link guest must never call (403 on every one, E8). */
const ESTIMATION = /\/estimation-sessions/;

const SESSION = '0192cccc-0000-7000-8000-000000000001';
const ITEM = '0192cccc-0000-7000-8000-0000000000a1';
const S = `${B}/estimation-sessions/${SESSION}`;

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
  /** A Rotation estimation session on the board, as the server would keep it. */
  estimation?: Rotation;
  /** The bodies of setRotationEstimate. */
  estimates: unknown[];
}

interface Rotation {
  state: 'LOBBY' | 'ROTATING';
  joined: boolean;
  version: number;
  entry?: { value: string; reason?: string; kept: boolean };
}

const ALICE = { id: '5e5e5e5e-0000-4000-8000-000000000001', displayName: 'Alice Admin' };
const BOB = { id: '5e5e5e5e-0000-4000-8000-000000000002', displayName: 'Bob Builder' };
const GINA = { id: '5e5e5e5e-0000-4000-8000-000000000003', displayName: 'Gina' };

/** getEstimationSession as the guest Gina sees it: round 2 of 2, she holds "Login". */
function rotation(r: Rotation) {
  const rotating = r.state === 'ROTATING';
  const seat = (s: { id: string; displayName: string }, guest: boolean, done = false) => ({
    ...s,
    guest,
    seated: true,
    done,
  });
  return {
    id: SESSION,
    mode: 'ROTATION',
    title: 'Sprint 42',
    deck: { kind: 'FIBONACCI', values: ['0', '1', '2', '3', '5', '8', '13', '21', '?', 'coffee'] },
    anonymous: true,
    settings: { rounds: 2, roundSeconds: 120, advanceWhenDone: true },
    state: r.state,
    round: rotating ? 1 : 0,
    ...(rotating ? { phaseEndsAt: new Date(Date.now() + 90_000).toISOString() } : {}),
    serverTime: new Date().toISOString(),
    moderatorName: 'Alice Admin',
    createdAt: '2026-11-19T09:59:00Z',
    version: r.version,
    seats: [
      seat(ALICE, false),
      seat(BOB, false, rotating),
      ...(r.joined ? [seat(GINA, true, !!r.entry)] : []),
    ],
    items: [
      {
        id: ITEM,
        ref: { kind: 'STORY', blockId: '11111111-1111-4111-8111-111111111111' },
        title: 'Login',
        position: 0,
        mine: rotating,
        ...(rotating ? { currentValue: '3' } : {}),
        ...(rotating && r.entry ? { myEntry: r.entry } : {}),
      },
      {
        id: '0192cccc-0000-7000-8000-0000000000b2',
        ref: { kind: 'STORY', blockId: '22222222-2222-4222-8222-222222222222' },
        title: 'Checkout',
        position: 1,
        mine: false,
      },
    ],
    me: { ...(r.joined ? { seatId: GINA.id } : {}), seated: r.joined, moderator: false },
  };
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
  const api: Api = { calls: [], estimates: [] };
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
    if (path === `${B}/estimation-sessions`) {
      const r = api.estimation;
      return json(route, {
        items: r
          ? [
              {
                id: SESSION,
                mode: 'ROTATION',
                title: 'Sprint 42',
                state: r.state,
                round: r.state === 'ROTATING' ? 1 : 0,
                moderatorName: 'Alice Admin',
                createdAt: '2026-11-19T09:59:00Z',
                seatCount: r.joined ? 3 : 2,
                itemCount: 2,
                me: { seated: r.joined, moderator: false },
              },
            ]
          : [],
      });
    }
    if (api.estimation && path === S) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { ETag: `W/"${api.estimation.version}"` },
        body: JSON.stringify(rotation(api.estimation)),
      });
    }
    if (api.estimation && path === `${S}/seats/me` && request.method() === 'PUT') {
      api.estimation.joined = true;
      api.estimation.version++;
      return route.fulfill({ status: 204 });
    }
    if (api.estimation && path === `${S}/items/${ITEM}/estimate` && request.method() === 'PUT') {
      const body = request.postDataJSON() as { value: string; reason?: string };
      api.estimates.push(body);
      api.estimation.entry = { ...body, kept: body.value === '3' };
      api.estimation.version++;
      return json(route, api.estimation.entry);
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
    expect(
      api.calls.filter((c) => ESTIMATION.test(c)),
      'no estimation session call for VIEWER links (E8)',
    ).toEqual([]);
    await expect(page.getByTestId('estimation-pill'), 'no sessions pill').toHaveCount(0);
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

  test('when a guest on an edit link joins a Rotation then it estimates with allowlisted calls only and never moderates', async ({
    page,
  }) => {
    const api = await mockApi(page, 'EDITOR');
    api.estimation = { state: 'LOBBY', joined: false, version: 1 };
    await page.goto(`/s#${TOKEN}`);
    await expect(page, 'on the guest board').toHaveURL(new RegExp(`/s/b/${BOARD}$`), {
      timeout: 15_000,
    });

    const pill = page.getByTestId('estimation-pill');
    await expect(pill, 'one active session').toHaveText(/1 session/, { timeout: 15_000 });
    await pill.click();
    await expect(page.getByTestId('new-estimation-session'), 'guests never create').toHaveCount(0);
    await page.getByRole('button', { name: /Sprint 42/ }).click();

    const panel = page.getByTestId('estimation-session');
    await expect(panel.getByTestId('anonymity'), 'the limits of anonymity (E6)').toContainText(
      'next holder of a card sees the previous value',
    );
    await panel.getByRole('button', { name: 'Join' }).click();
    await expect(panel.getByTestId('lobby-seats'), 'joined').toContainText('you');
    await expect(panel.getByRole('button', { name: 'Start' }), 'no start').toHaveCount(0);

    // the moderator starts: round 2 of 2, Gina holds "Login" (previous estimate 3)
    api.estimation.state = 'ROTATING';
    api.estimation.version++;
    const card = panel.getByTestId('held-card');
    await expect(card, 'my card').toContainText('Previous estimate: 3', { timeout: 10_000 });
    await expect(panel.getByTestId('countdown'), 'countdown').toBeVisible();
    await card.getByRole('button', { name: '5', exact: true }).click();
    await card.getByRole('textbox', { name: 'Why do you change it?' }).fill('Needs a migration');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByTestId('saved'), 'saved').toHaveText('Saved: 5');
    await expect(panel.getByTestId('moderator-controls'), 'never moderates').toHaveCount(0);

    expect(api.estimates, 'value, reason and the expected round (E14)').toEqual([
      { value: '5', reason: 'Needs a migration', round: 1 },
    ]);
    expect(forbidden(api), 'only allowlisted calls').toEqual([]);
    expect(
      api.calls.filter((c) => /^POST .*estimation-sessions/.test(c)),
      'never create, start, advance, finish or cancel',
    ).toEqual([]);
    expect(
      api.calls.filter((c) => /\/decision$/.test(c)),
      'never decide',
    ).toEqual([]);
  });

  test('when a guest opens a comment link then estimation sessions are listed with state ACTIVE only', async ({
    page,
  }) => {
    const api = await openAsGuest(page, 'COMMENTER');

    await expect
      .poll(() => api.calls.filter((c) => ESTIMATION.test(c)), { message: 'the list' })
      .toEqual([`GET ${B}/estimation-sessions?state=ACTIVE`]);
    expect(forbidden(api), 'only allowlisted calls').toEqual([]);
  });
});
