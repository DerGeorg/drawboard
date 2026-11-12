import { Page, expect, test } from '@playwright/test';

import { openGuestBoard } from '../support/guest-board';

/**
 * Copy, cut and paste of blocks with the real keyboard and the real clipboard events of the
 * browser (jsdom has neither), on the board of a guest with an edit link. Every /api call is
 * mocked; the collaboration socket is not served, so the board stays local.
 */

async function canvasPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId('canvas').boundingBox();
  if (!box) {
    throw new Error('no canvas');
  }
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

test.describe('clipboard in a real browser', () => {
  test('when a sticky is copied, pasted, cut and edited then the board and the text field behave', async ({
    page,
  }) => {
    await openGuestBoard(page);
    const stickies = page.locator('.be-sticky');

    // a sticky with text
    await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
    const first = await canvasPoint(page, 0.4, 0.4);
    await page.mouse.click(first.x, first.y);
    await page.keyboard.type('Copy me');
    await page.keyboard.press('Escape');
    await expect(stickies, 'one sticky').toHaveText(['Copy me']);

    // copy, then paste twice at the pointer: the second one steps aside
    await page.keyboard.press('ControlOrMeta+c');
    const target = await canvasPoint(page, 0.7, 0.6);
    await page.mouse.move(target.x, target.y);
    await page.keyboard.press('ControlOrMeta+v');
    await expect(stickies, 'pasted').toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+v');
    await expect(stickies, 'pasted again').toHaveText(['Copy me', 'Copy me', 'Copy me']);
    const boxes = await Promise.all([1, 2].map((i) => stickies.nth(i).boundingBox()));
    expect(boxes[0], 'first paste centred at the pointer').toMatchObject({
      x: expect.closeTo(target.x - (boxes[0]?.width ?? 0) / 2, 0) as number,
    });
    expect((boxes[1]?.x ?? 0) - (boxes[0]?.x ?? 0), 'second steps 20 px').toBeCloseTo(20, 0);

    // while text is edited, the browser's own copy and paste apply - no new blocks
    await stickies.first().dblclick();
    const editor = page.locator('textarea.be-text-editor');
    await expect(editor, 'editing').toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('End');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(editor, 'text pasted into the text').toHaveValue('Copy meCopy me');
    await page.keyboard.press('Escape');
    await expect(stickies, 'still three blocks').toHaveCount(3);

    // cut the last one, and paste it back in again
    await stickies.nth(2).click();
    await page.keyboard.press('ControlOrMeta+x');
    await expect(stickies, 'cut').toHaveCount(2);
    await page.mouse.move(first.x, first.y + 150);
    await page.keyboard.press('ControlOrMeta+v');
    await expect(stickies, 'pasted after cut').toHaveCount(3);

    // one undo removes the paste
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(stickies, 'undone').toHaveCount(2);
  });
});
