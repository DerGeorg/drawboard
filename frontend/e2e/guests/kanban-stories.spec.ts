import { Locator, Page, expect, test } from '@playwright/test';

import { openGuestBoard as openBoard } from '../support/guest-board';

/**
 * Story cards dragged into a kanban column, with a real layout and real pointer events, on the
 * board of a guest with an edit link. Every /api call is mocked; the collaboration socket is not
 * served, so the board stays local.
 */

async function dragTo(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await from.boundingBox();
  if (!box) {
    throw new Error('nothing to drag');
  }
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 30, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test.describe('story cards and kanban in a real browser', () => {
  test('when a story card is dragged into a column then it becomes a card there and undo brings it back', async ({
    page,
  }) => {
    await openBoard(page);
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    const kanban = page.locator('.be-kanban');
    await expect(kanban, 'the kanban').toBeVisible();
    await page.getByRole('button', { name: 'Story card', exact: true }).click();
    const story = page.locator('.be-story');
    await expect(story, 'a story card').toBeVisible();
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Checkout');
    await page.getByRole('textbox', { name: 'Description' }).fill('Pay with a card');
    const estimate = page.getByRole('textbox', { name: 'Estimate' });
    await estimate.fill('8');
    await estimate.press('Enter');
    await page.getByRole('button', { name: 'Close the story card' }).click();
    await expect(story.locator('.be-story-title'), 'titled').toHaveText('Checkout');

    // drag it away from the kanban first, so that the drop is a real drag over the columns
    const doing = kanban.locator('[data-column-id]').nth(1);
    const kanbanBox = await kanban.boundingBox();
    await dragTo(page, story, {
      x: (kanbanBox?.x ?? 0) + (kanbanBox?.width ?? 0) + 200,
      y: (kanbanBox?.y ?? 0) + 100,
    });
    await expect(story, 'still a story card').toBeVisible();

    const doingBox = await doing.boundingBox();
    const storyBox = await story.boundingBox();
    await page.mouse.move((storyBox?.x ?? 0) + 20, (storyBox?.y ?? 0) + 20);
    await page.mouse.down();
    await page.mouse.move((doingBox?.x ?? 0) + 100, (doingBox?.y ?? 0) + 100, { steps: 12 });
    await expect(doing, 'the column under the pointer is highlighted').toHaveAttribute(
      'data-drop',
      'story',
    );
    await expect(kanban.locator('.be-kb-drop'), 'the insert position shows').toHaveCount(1);
    await page.mouse.up();

    await expect(story, 'the story card is gone').toHaveCount(0);
    const card = doing.getByRole('listitem', { name: /Checkout/ });
    await expect(card, 'a card in the column').toBeVisible();
    await expect(card, 'with its estimate and a details symbol').toContainText('8');
    await expect(card.locator('.be-kb-details'), 'description marker').toBeVisible();
    await expect(doing.locator('.be-kb-drop'), 'no marker left').toHaveCount(0);

    // one undo brings the story card back
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(doing.locator('[data-card-id]'), 'card gone').toHaveCount(0);
    await expect(page.locator('.be-story'), 'story back').toHaveCount(1);
    await expect(
      page.locator('.be-story .be-story-description'),
      'with its description',
    ).toHaveText('Pay with a card');
  });
});
