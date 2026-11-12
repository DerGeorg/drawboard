import { Locator, Page, expect, test } from '@playwright/test';

import { openGuestBoard } from '../support/guest-board';

/**
 * A table (frames in a parent frame) with real pointer events and layout, on the board of a
 * guest with an edit link. Every /api call is mocked; the collaboration socket is not served.
 */

async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) {
    throw new Error('not on screen');
  }
  return b;
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test.describe('tables in a real browser', () => {
  test('when a card is sorted into a cell and a column is added then the card stays in its cell', async ({
    page,
  }) => {
    await openGuestBoard(page);
    const canvas = await box(page.getByTestId('canvas'));

    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await page.mouse.click(canvas.x + canvas.width * 0.45, canvas.y + canvas.height * 0.45);
    const cells = page.locator('[data-cell]');
    await expect(cells, '3 x 3 cells').toHaveCount(9);
    await expect(page.locator('[data-cell="0,0"] .be-frame-title'), 'header').toHaveText(
      'Column 1',
    );

    // a card dropped into the last column of the first body row
    await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
    const start = { x: canvas.x + canvas.width * 0.92, y: canvas.y + canvas.height * 0.15 };
    await page.mouse.click(start.x, start.y);
    await page.keyboard.type('Card');
    await page.keyboard.press('Escape');
    const sticky = page.locator('.be-sticky');
    const target = await box(page.locator('[data-cell="1,2"]'));
    await drag(page, start, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
    const dropped = await box(sticky);

    // select the first header cell and add a column to its right: the card moves with its cell
    const header = await box(page.locator('[data-cell="0,0"]'));
    await page.mouse.click(header.x + header.width / 2, header.y + header.height - 6);
    await page.getByRole('button', { name: 'Add column' }).click();
    await expect(cells, 'one column more').toHaveCount(12);
    const moved = await box(sticky);
    const cellNow = await box(page.locator('[data-cell="1,3"]'));
    expect(moved.x - dropped.x, 'moved by one column').toBeCloseTo(cellNow.x - target.x, 0);
    expect(moved.x > cellNow.x && moved.x < cellNow.x + cellNow.width, 'still in its cell').toBe(
      true,
    );

    // moving the table by its title takes cells and card along
    const title = await box(page.locator('.be-frame-title', { hasText: 'Table' }));
    await drag(
      page,
      { x: title.x + 10, y: title.y + title.height / 2 },
      { x: title.x + 60, y: title.y + title.height / 2 + 40 },
    );
    const after = await box(sticky);
    expect(after.y - moved.y, 'card followed the table').toBeCloseTo(40, 0);

    // undo puts the table back, the card with it
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await box(sticky)).y, 'back').toBeCloseTo(moved.y, 0);
  });
});
