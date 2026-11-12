import { Page, expect, test } from '@playwright/test';

import { MockCollabSocket, PeerFrom } from '../support/collab-socket';
import { openGuestBoard } from '../support/guest-board';

/**
 * Follow and summon in a real browser, on the board of a guest with an edit link. The mocked
 * collaboration socket plays the other participants: their awareness arrives wrapped in the
 * server's `From` exactly as the backend relays it (S2.6). A guest may follow and be summoned,
 * never summon; the presenter side (signed-in editors) is covered by the unit tests.
 */

const BOB: PeerFrom = {
  id: 'id-bob',
  name: 'Bob',
  guest: false,
  role: 'EDITOR',
  color: '#2563eb',
  clientId: 4242,
};
const MALLORY: PeerFrom = {
  id: 'guest:m',
  name: 'Mallory',
  guest: true,
  color: '#e03131',
  clientId: 666,
};

async function liveBoard(page: Page): Promise<MockCollabSocket> {
  const collab = new MockCollabSocket();
  await openGuestBoard(page, { collab });
  await expect(page.getByText('Live', { exact: true }), 'connected').toBeVisible({
    timeout: 15_000,
  });
  return collab;
}

const zoomLabel = (page: Page) => page.getByRole('button', { name: 'Reset zoom to 100%' });

test.describe('follow and summon', () => {
  test('when a guest follows Bob then the camera tracks his view until Escape', async ({
    page,
  }) => {
    const collab = await liveBoard(page);
    await expect
      .poll(() => collab.lastState()?.['viewport'], 'own viewport published')
      .toBeTruthy();

    collab.awareness(BOB, {
      cursor: null,
      selection: [],
      viewport: { x: 3000, y: 2000, zoom: 0.5 },
    });
    await page.getByRole('button', { name: 'Options for Bob' }).click();
    await page.getByRole('menuitem', { name: 'Follow' }).click();

    await expect(page.getByTestId('follow-status'), 'indicator').toContainText('Following Bob');
    await expect(page.getByTestId('follow-frame'), 'frame').toBeVisible();
    await expect(zoomLabel(page), 'camera at his zoom').toHaveText('50%');
    await expect.poll(() => collab.lastState()?.['following'], 'others see it').toBe(BOB.clientId);
    await expect
      .poll(() => collab.lastState()?.['viewport'], 'own view now his')
      .toEqual({ x: 3000, y: 2000, zoom: 0.5 });

    collab.awareness(BOB, { viewport: { x: -500, y: 100, zoom: 0.25 } });
    await expect(zoomLabel(page), 'tracks him').toHaveText('25%');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('follow-status'), 'stopped').toHaveCount(0);
    await expect.poll(() => collab.lastState()?.['following'], 'no longer').toBeUndefined();
    collab.awareness(BOB, { viewport: { x: 0, y: 0, zoom: 2 } });
    await expect(zoomLabel(page), 'camera stays').toHaveText('25%');
  });

  test('when the followed participant leaves then following stops with a notice', async ({
    page,
  }) => {
    const collab = await liveBoard(page);
    collab.awareness(BOB, { viewport: { x: 0, y: 0, zoom: 1 } });
    await page.getByRole('button', { name: 'Options for Bob' }).click();
    await page.getByRole('menuitem', { name: 'Follow' }).click();
    await expect(page.getByTestId('follow-status'), 'following').toBeVisible();

    collab.peerLeft(BOB);

    await expect(
      page.getByText('Bob left the board - you stopped following.'),
      'notice',
    ).toBeVisible();
    await expect(page.getByTestId('follow-status'), 'stopped').toHaveCount(0);
  });

  test('when a signed-in participant summons everyone then the guest follows until Stop and is not pulled back', async ({
    page,
  }) => {
    const collab = await liveBoard(page);

    collab.awareness(BOB, {
      viewport: { x: 800, y: 400, zoom: 0.4 },
      summon: { id: 5, targets: 'all' },
    });

    await expect(page.getByTestId('follow-status'), 'summoned').toContainText(
      "Bob is presenting - you're following",
    );
    await expect(zoomLabel(page), 'camera').toHaveText('40%');

    // Stop is local and final for this summon
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByTestId('follow-status'), 'stopped').toHaveCount(0);
    collab.awareness(BOB, { viewport: { x: 0, y: 0, zoom: 1 }, summon: { id: 5, targets: 'all' } });
    await expect(zoomLabel(page), 'not pulled back').toHaveText('40%');

    // a new summon right away is within the cooldown: ignored
    collab.awareness(BOB, { viewport: { x: 0, y: 0, zoom: 1 }, summon: { id: 6, targets: 'all' } });
    // a later frame has arrived, so the summon above has been handled
    collab.awareness(MALLORY, { cursor: { x: 1, y: 1 } });
    await expect(
      page.getByRole('button', { name: 'Options for Mallory' }),
      'later frame',
    ).toBeVisible();
    await expect(page.getByTestId('follow-status'), 'cooldown').toHaveCount(0);
  });

  test('when the presenter ends the summon then the follower stops with a notice', async ({
    page,
  }) => {
    const collab = await liveBoard(page);
    collab.awareness(BOB, { viewport: { x: 0, y: 0, zoom: 1 }, summon: { id: 9, targets: 'all' } });
    await expect(page.getByTestId('follow-status'), 'summoned').toBeVisible();

    collab.awareness(BOB, { viewport: { x: 0, y: 0, zoom: 1 } });

    await expect(page.getByText('Bob stopped presenting.'), 'notice').toBeVisible();
    await expect(page.getByTestId('follow-status'), 'stopped').toHaveCount(0);
  });

  test('when a guest or an oversized or text-carrying payload summons then nothing happens', async ({
    page,
  }) => {
    const collab = await liveBoard(page);

    collab.awareness(MALLORY, {
      viewport: { x: 0, y: 0, zoom: 4 },
      summon: { id: 1, targets: 'all' },
    });
    collab.awareness(BOB, {
      viewport: { x: 0, y: 0, zoom: 4 },
      summon: { id: 2, targets: Array.from({ length: 51 }, (_, i) => i) },
    });
    collab.awareness(
      { ...BOB, clientId: 4243, id: 'id-eve', name: 'Eve' },
      {
        viewport: { x: Number.MAX_VALUE, y: 0, zoom: 4 },
        summon: { id: 3, targets: 'all' },
        name: '<img src=x onerror=alert(1)>',
      },
    );

    await expect(page.getByTestId('follow-status'), 'Eve is followed (valid summon)').toContainText(
      "Eve is presenting - you're following",
    );
    await expect(page.getByText('<img', { exact: false }), 'payload text never shown').toHaveCount(
      0,
    );
    await expect(zoomLabel(page), 'invalid viewport not used').toHaveText('100%');

    // ignore Eve: following ends and her next summon is not followed
    await page.getByRole('button', { name: 'Ignore', exact: true }).click();
    await expect(page.getByTestId('follow-status'), 'ignored').toHaveCount(0);
  });
});
