import { expect, test, uniqueTitle } from '../support/fixtures';
import { users } from '../support/users';

test.describe('boards', () => {
  test.describe('as alice', () => {
    test.use({ storageState: users.alice.storageState });

    test('when alice renames and trashes a board from its card then the backend follows every step', async ({
      page,
      asAlice,
    }) => {
      const board = await asAlice.create(uniqueTitle('lifecycle'));
      await page.goto('/boards');

      const card = page.getByRole('article', { name: board.title });
      await expect(card, 'card of the board').toBeVisible();
      await expect(card.getByTestId('role'), 'role of the creator').toHaveText('Owner');

      await card.getByRole('button', { name: 'Board actions' }).click();
      await card.getByRole('menuitem', { name: 'Rename' }).click();
      await page.getByLabel('Title of the board').fill(`${board.title} (renamed)`);
      await page.getByRole('button', { name: 'Save' }).click();
      const renamed = page.getByRole('article', { name: `${board.title} (renamed)` });
      await expect(renamed, 'card after renaming').toBeVisible();
      expect((await asAlice.find(board.id))?.title, 'title in the backend').toBe(
        `${board.title} (renamed)`,
      );

      await renamed.getByRole('button', { name: 'Board actions' }).click();
      await renamed.getByRole('menuitem', { name: 'Move to trash' }).click();
      // The confirmation replaces the card's title link, so the article has no name while it is
      // shown: "card gone" is true at once. Wait for the request instead.
      const [deleted] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith(`/api/boards/${board.id}`) && r.request().method() === 'DELETE',
        ),
        page.getByRole('button', { name: 'Yes, move to trash' }).click(),
      ]);
      expect(deleted.status(), 'status of the delete request').toBe(204);
      await expect(renamed, 'card after trashing').toHaveCount(0);
      expect(await asAlice.find(board.id), 'board in the backend after trashing').toBe(undefined);
    });

    test('when alice clicks New board then a board is created and the editor opens', async ({
      page,
      asAlice,
    }) => {
      await page.goto('/boards');

      const [response] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith('/api/boards') && r.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'New board' }).first().click(),
      ]);
      const created = (await response.json()) as { id: string };
      asAlice.track(created.id);

      await expect(page, 'URL of the editor').toHaveURL(new RegExp(`/boards/${created.id}$`));
      await expect(page.getByTestId('canvas'), 'canvas').toBeVisible();
      await expect(page.getByRole('heading', { level: 1 }), 'board title').toHaveText(
        'Untitled board',
      );
    });

    test('when alice opens a seeded board then its title and the canvas are shown', async ({
      page,
      asAlice,
    }) => {
      const board = await asAlice.create(uniqueTitle('seeded'));

      await page.goto(`/boards/${board.id}`);

      await expect(page.getByRole('heading', { level: 1 }), 'board title').toHaveText(board.title);
      await expect(page.getByTestId('canvas'), 'canvas').toBeVisible();
    });

    test('when alice opens a board that does not exist then the not-found page is shown', async ({
      page,
    }) => {
      await page.goto('/boards/01929a4e-0000-7000-8000-00000000dead');

      await expect(page.getByRole('heading', { level: 1 }), 'page heading').toHaveText(
        'Page not found',
      );
    });
  });

  test.describe('as bob', () => {
    test.use({ storageState: users.bob.storageState });

    test("when bob opens alice's board then he does not get access", async ({ page, asAlice }) => {
      const board = await asAlice.create(uniqueTitle('private'));

      await page.goto(`/boards/${board.id}`);

      await expect(page.getByRole('heading', { level: 1 }), 'page heading').toHaveText(
        'Page not found',
      );
    });
  });
});
