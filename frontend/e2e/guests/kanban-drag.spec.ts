import { Locator, Page, expect, test } from '@playwright/test';

import { openGuestBoard as openBoard } from '../support/guest-board';

/**
 * The kanban block with a real layout and real pointer events (jsdom has neither), on the board
 * of a guest with an edit link - the one board page that opens without a login. Every /api call
 * is mocked; the collaboration socket is not served, so the board stays local.
 */

async function dragTo(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await from.boundingBox();
  if (!box) {
    throw new Error('nothing to drag');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test.describe('kanban in a real browser', () => {
  test('when cards are added, dragged between columns and out onto the canvas then the board follows', async ({
    page,
  }) => {
    await openBoard(page);
    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    const kanban = page.locator('.be-kanban');
    await expect(kanban, 'the kanban').toBeVisible();

    await kanban.getByRole('button', { name: 'Add a card to To do' }).click();
    const field = kanban.getByRole('textbox', { name: 'Title of a new card in To do' });
    await field.fill('Write docs');
    await field.press('Enter');
    await field.fill('Fix bug');
    await field.press('Enter');
    await field.press('Escape');
    const todo = kanban.locator('[data-column-id]').nth(0);
    const doing = kanban.locator('[data-column-id]').nth(1);
    await expect(todo.locator('[data-card-id]'), 'two cards').toHaveCount(2);

    // into the next column, by mouse
    const doingBox = await doing.boundingBox();
    await dragTo(page, todo.getByRole('listitem', { name: /Write docs/ }), {
      x: (doingBox?.x ?? 0) + 100,
      y: (doingBox?.y ?? 0) + 80,
    });
    await expect(doing.getByRole('listitem', { name: /Write docs/ }), 'moved').toBeVisible();
    await expect(todo.locator('[data-card-id]'), 'one left').toHaveCount(1);

    // and back with the keyboard
    const moved = doing.getByRole('listitem', { name: /Write docs/ });
    await moved.focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(todo.locator('[data-card-id]'), 'back by keyboard').toHaveCount(2);
    await expect(
      todo.getByRole('listitem', { name: /Write docs/ }),
      'the moved card keeps the focus',
    ).toBeFocused();

    // out of the kanban onto the canvas: a sticky note with the title
    const kanbanBox = await kanban.boundingBox();
    await dragTo(page, todo.getByRole('listitem', { name: /Fix bug/ }), {
      x: (kanbanBox?.x ?? 0) + (kanbanBox?.width ?? 0) / 2,
      y: (kanbanBox?.y ?? 0) + (kanbanBox?.height ?? 0) + 150,
    });
    await expect(page.locator('.be-sticky'), 'a sticky note').toHaveText('Fix bug');
    await expect(todo.locator('[data-card-id]'), 'the card left the kanban').toHaveCount(1);

    // one undo brings the card back
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.be-sticky'), 'sticky gone').toHaveCount(0);
    await expect(todo.locator('[data-card-id]'), 'card back').toHaveCount(2);
  });
});
