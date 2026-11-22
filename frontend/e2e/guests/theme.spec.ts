import { expect, test } from '@playwright/test';

import { openGuestBoard } from '../support/guest-board';

/**
 * The theme switch on the board of a guest with an edit link. Every /api call is mocked; the
 * guest keeps the choice in the browser and never calls /api/users/me/preferences.
 */

const LIGHT_PAPER = 'rgb(247, 247, 245)';
const DARK_PAPER = 'rgb(15, 23, 42)';

test.describe('dark mode for a guest', () => {
  test('when the guest chooses Dark then the canvas turns dark and stays dark after a reload', async ({
    page,
  }) => {
    const preferenceCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/users/me/preferences')) {
        preferenceCalls.push(request.method());
      }
    });
    await openGuestBoard(page);
    const canvas = page.getByTestId('canvas');
    await expect(canvas, 'paper of the light theme').toHaveCSS('background-color', LIGHT_PAPER);

    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();

    await expect(page.locator('html'), 'attribute').toHaveAttribute('data-theme', 'dark');
    await expect(canvas, 'paper of the dark theme').toHaveCSS('background-color', DARK_PAPER);
    // the menu closed with the choice; opened again it marks Dark as the current one
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await expect(
      page.getByRole('menuitemradio', { name: 'Dark' }),
      'Dark is the current choice',
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // the board is drawn dark too: a new text block takes the default ink, shown light
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    const box = await canvas.boundingBox();
    await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 200);
    await page.keyboard.type('Dark text');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-block-type="core.text"] .be-text'), 'default ink').toHaveCSS(
      'color',
      'rgb(226, 232, 240)',
    );

    // a fresh load of the same link: the remembered choice is applied before the first paint
    await page.goto(`/s#${'K'.repeat(43)}`);
    await expect(page.getByTestId('canvas'), 'dark after the reload').toHaveCSS(
      'background-color',
      DARK_PAPER,
      { timeout: 15_000 },
    );
    await expect(page.locator('html'), 'attribute after the reload').toHaveAttribute(
      'data-theme',
      'dark',
    );
    expect(
      await page.evaluate(() => window.localStorage.getItem('drawboard.theme')),
      'remembered in the browser',
    ).toBe('DARK');
    expect(preferenceCalls, 'a guest never saves preferences on the server').toEqual([]);
  });

  test('when the system is dark and the guest has chosen nothing then the board is dark', async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();

    await openGuestBoard(page);

    await expect(page.getByTestId('canvas'), 'paper').toHaveCSS('background-color', DARK_PAPER);
    await expect(page.locator('html'), 'no fixed choice').not.toHaveAttribute('data-theme', /.+/);
    await context.close();
  });
});
