import { expect, test } from '@playwright/test';

import { users } from './support/users';

// Logs in once per user through the real login page of the provider (Keycloak in the dev
// stack) and stores the session (the provider's SSO cookies). The test projects start from that
// state: the app's silent sign-in at startup restores the login without a form.
test.describe('login', () => {
  for (const user of Object.values(users)) {
    test(`when ${user.name} signs in through the provider then the session is stored`, async ({
      page,
    }) => {
      await page.goto('/boards');

      await expect(page, 'redirect to the login page').toHaveURL(
        /\/realms\/drawboard\/protocol\/openid-connect\/auth/,
      );
      await page.getByLabel('Username or email').fill(user.name);
      await page.getByLabel('Password', { exact: true }).fill(user.password);
      await page.getByRole('button', { name: 'Sign In' }).click();

      await expect(page.getByTestId('current-user'), 'display name in the header').toBeVisible();
      await expect(page, 'back on the requested page').toHaveURL(/\/boards$/);
      await page.context().storageState({ path: user.storageState });
    });
  }
});
