import { expect, test } from '@playwright/test';

import { MockCollabSocket } from '../support/collab-socket';
import { GIF_ID, GIF_URL, boardWithGif, mockGiphy } from '../support/gif-board';
import { openGuestBoard } from '../support/guest-board';

/**
 * GIF blocks in a real browser (architecture 3.14, Fable G9-G12), on the board of a guest with an
 * edit link. Every /api call is mocked, and so is GIPHY: media.giphy.com is answered by the test
 * (`page.route`), no request ever reaches the real one. The board comes from the mocked
 * collaboration socket as a snapshot. Against the built image the server needs GIFS_ENABLED=true
 * (the angular-e2e job sets it); `ng serve` has the switch on in environment.development.ts.
 */

const CONSENT_KEY = 'drawboard.gifs.consent';

test.describe('GIF blocks in a real browser', () => {
  test('when a guest opens a board with a GIF then a placeholder shows and GIPHY is not asked', async ({
    page,
  }) => {
    const giphy = await mockGiphy(page);
    await openGuestBoard(page, { collab: new MockCollabSocket({ snapshot: boardWithGif() }) });
    const block = page.locator('[data-block-type="core.gif"]');

    await expect(block, 'the GIF block').toHaveCount(1);
    await expect(block, 'consent text').toContainText('loading it sends your IP address to GIPHY');
    await expect(block.getByRole('button', { name: 'Load' }), 'Load').toBeVisible();
    await expect(
      block.getByRole('button', { name: 'Always in this browser' }),
      'Always',
    ).toBeVisible();
    await expect(block.locator('img'), 'no image').toHaveCount(0);
    // two frames later: anything that was going to load has asked by now
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(giphy, 'no request to GIPHY').toEqual([]);
    await expect(
      page.getByRole('button', { name: 'GIF', exact: true }),
      'a guest has no GIF picker (G5)',
    ).toHaveCount(0);
  });

  test('when the guest clicks Load then the image is requested from the GIPHY URL, for this board only', async ({
    page,
  }) => {
    const giphy = await mockGiphy(page);
    await openGuestBoard(page, { collab: new MockCollabSocket({ snapshot: boardWithGif() }) });
    const block = page.locator('[data-block-type="core.gif"]');

    await block.getByRole('button', { name: 'Load' }).click();

    const img = block.locator('img');
    await expect(img, 'the image').toHaveCount(1);
    await expect(img, 'src').toHaveAttribute('src', GIF_URL);
    await expect(img, 'crossorigin').toHaveAttribute('crossorigin', 'anonymous');
    await expect(img, 'referrer policy').toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(img, 'no srcset').not.toHaveAttribute('srcset', /.*/);
    await expect(img, 'alt').toHaveAttribute('alt', 'A cat on a keyboard');
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
        message: 'the image decoded',
      })
      .toBe(true);
    expect(giphy, 'one request, to the one URL').toEqual([GIF_URL]);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY),
      'Load stores nothing',
    ).toBeNull();
    expect(GIF_URL, 'built from the id').toContain(GIF_ID);
  });

  test('when the guest chooses Always then it is stored, and Forget GIF consent takes it back', async ({
    page,
  }) => {
    const giphy = await mockGiphy(page);
    await openGuestBoard(page, { collab: new MockCollabSocket({ snapshot: boardWithGif() }) });
    const block = page.locator('[data-block-type="core.gif"]');

    await block.getByRole('button', { name: 'Always in this browser' }).click();

    await expect(block.locator('img'), 'loaded').toHaveCount(1);
    expect(await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY), 'stored').toBe(
      'always',
    );

    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByTestId('forget-gifs').click();

    await expect(block.locator('img'), 'image gone').toHaveCount(0);
    await expect(block, 'placeholder again').toContainText('sends your IP address to GIPHY');
    expect(await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY), 'removed').toBe(
      null,
    );
    expect(giphy, 'only the one load before').toHaveLength(1);
  });

  test('when the GIF is zoomed far out then it is a flat box and nothing is loaded', async ({
    page,
  }) => {
    const giphy = await mockGiphy(page);
    await openGuestBoard(page, { collab: new MockCollabSocket({ snapshot: boardWithGif() }) });
    // 1.25 per step: ten steps are below the 15 % where blocks turn into plain boxes
    const out = page.getByRole('button', { name: 'Zoom out' });
    for (let step = 0; step < 10; step++) {
      await out.click();
    }

    await expect(
      page.locator('[data-block-type="core.gif"][data-lod="simple"]'),
      'flat',
    ).toHaveCount(1);
    await expect(page.locator('[data-block-type="core.gif"] img'), 'no image').toHaveCount(0);
    expect(giphy, 'no request').toEqual([]);
  });
});
