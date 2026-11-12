import { Locator, Page, expect, test } from '@playwright/test';

import { openGuestBoard } from '../support/guest-board';

/**
 * Frames with real pointer events and layout (jsdom has neither), on the board of a guest with
 * an edit link. Every /api call is mocked; the collaboration socket is not served.
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

test.describe('frames in a real browser', () => {
  test('when a sticky is dropped into a frame and the frame is moved then the sticky follows', async ({
    page,
  }) => {
    await openGuestBoard(page);
    const canvas = await box(page.getByTestId('canvas'));
    const at = (fx: number, fy: number) => ({
      x: canvas.x + canvas.width * fx,
      y: canvas.y + canvas.height * fy,
    });

    // draw a frame
    await page.getByRole('button', { name: 'Frame', exact: true }).click();
    await drag(page, at(0.25, 0.2), at(0.6, 0.7));
    const frame = page.locator('.be-frame');
    await expect(frame, 'a frame').toHaveCount(1);
    await expect(page.locator('.be-frame-title'), 'numbered title').toHaveText('Frame 1');

    // a sticky outside it, then dropped into it
    await page.getByRole('button', { name: 'Sticky note', exact: true }).click();
    const outside = at(0.8, 0.4);
    await page.mouse.click(outside.x, outside.y);
    await page.keyboard.type('Inside');
    await page.keyboard.press('Escape');
    const sticky = page.locator('.be-sticky');
    await expect(sticky, 'sticky').toHaveText('Inside');
    const frameBox = await box(frame);
    await drag(page, outside, {
      x: frameBox.x + frameBox.width / 2,
      y: frameBox.y + frameBox.height / 2,
    });
    // the frame paints below the sticky: the sticky is still visible on top of it
    const dropped = await box(sticky);
    const onTop = await page.evaluate(
      (p) =>
        document.elementFromPoint(p.x, p.y)?.closest('.be-block')?.getAttribute('data-block-type'),
      { x: dropped.x + dropped.width / 2, y: dropped.y + dropped.height / 2 },
    );
    expect(onTop, 'sticky above the frame').toBe('core.sticky');

    // move the frame by its title: the sticky comes along
    const title = await box(page.locator('.be-frame-title'));
    await drag(
      page,
      { x: title.x + 20, y: title.y + title.height / 2 },
      {
        x: title.x + 120,
        y: title.y + title.height / 2 + 80,
      },
    );
    const frameMoved = await box(frame);
    const stickyMoved = await box(sticky);
    expect(frameMoved.x - frameBox.x, 'frame moved right').toBeCloseTo(100, 0);
    expect(stickyMoved.x - dropped.x, 'sticky followed right').toBeCloseTo(100, 0);
    expect(stickyMoved.y - dropped.y, 'sticky followed down').toBeCloseTo(80, 0);

    // one undo puts both back
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await box(sticky)).x, 'sticky back').toBeCloseTo(dropped.x, 0);
    expect((await box(frame)).x, 'frame back').toBeCloseTo(frameBox.x, 0);

    // deleting the frame by keyboard takes its content along
    await page.mouse.click(title.x + 20, title.y + title.height / 2);
    await page.keyboard.press('Delete');
    await expect(frame, 'frame gone').toHaveCount(0);
    await expect(sticky, 'its sticky too').toHaveCount(0);
  });
});
