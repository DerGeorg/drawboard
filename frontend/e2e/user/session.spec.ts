import { expect, test } from '@playwright/test';

import { users } from '../support/users';

test.describe('session', () => {
  test.describe('as bob', () => {
    test.use({ storageState: users.bob.storageState });

    test('when bob opens the app then the header shows his display name', async ({ page }) => {
      await page.goto('/boards');

      await expect(page.getByTestId('current-user'), 'display name').toBeVisible();
      await expect(page.getByRole('complementary', { name: 'Library' }), 'app name').toContainText(
        'Drawboard',
      );
    });
  });

  test.describe('sign out', () => {
    // A session of its own: signing out ends the provider session, the stored one stays usable
    // for the other tests.
    test.use({ storageState: { cookies: [], origins: [] } });

    test('when alice signs out then the next visit asks for the login again', async ({ page }) => {
      await page.goto('/boards');
      await page.getByLabel('Username or email').fill(users.alice.name);
      await page.getByLabel('Password', { exact: true }).fill(users.alice.password);
      await page.getByRole('button', { name: 'Sign In' }).click();
      await expect(page.getByTestId('current-user'), 'user after login').toBeVisible();

      // Sign out lives in the account menu. Keycloak has an end_session_endpoint, so the app ends
      // the provider session there (signoutRedirect); without one it would only go to the
      // provider's logout page.
      await page.getByRole('button', { name: 'Account menu' }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await page.goto('/boards');

      await expect(page, 'login page of the provider').toHaveURL(
        /\/protocol\/openid-connect\/auth/,
      );
    });
  });
});
