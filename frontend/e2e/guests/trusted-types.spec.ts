import { expect, test } from '@playwright/test';

import { RECORD_VIOLATIONS, appCsp } from '../support/csp';
import { openGuestBoard } from '../support/guest-board';

/**
 * The served app under the ENFORCED production CSP with Trusted Types (S3.12, M4 review SHOULD
 * 5): a Mermaid diagram (also one with an `%%{init}%%` directive), a kanban and a story card on a
 * real board, and not one `securitypolicyviolation` event. The image's nginx sends the header;
 * `ng serve` does not, so the same CSP (from deploy/nginx/default.conf.template) is added to
 * the page here. Every /api call is mocked, the board is a guest's edit link.
 */
test.describe('enforced Trusted Types in the app', () => {
  test('when diagrams, a kanban and a story card are added then nothing is blocked', async ({
    page,
  }) => {
    await page.addInitScript(RECORD_VIOLATIONS);
    // the provider origin of this deployment goes into connect-src and frame-src, as in nginx
    const config = await page.request
      .get('/config.json')
      .then((r) => r.json() as Promise<{ oidcIssuer?: string }>)
      .catch(() => ({ oidcIssuer: 'http://localhost:18180' })); // ng serve: environment.ts
    const csp = appCsp({ oidc: config.oidcIssuer && new URL(config.oidcIssuer).origin });
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.resourceType() !== 'document') {
        return route.fallback();
      }
      const response = await route.fetch();
      const headers = response.headers();
      if (!headers['content-security-policy']) {
        headers['content-security-policy'] = csp;
      }
      return route.fulfill({ response, headers });
    });

    await openGuestBoard(page);

    expect(
      await page.evaluate(() => {
        try {
          document.createElement('div').innerHTML = '<b>x</b>';
          return 'allowed';
        } catch (e) {
          return (e as Error).name;
        }
      }),
      'Trusted Types are enforced: a raw string is refused',
    ).toBe('TypeError');

    // the sample diagram
    await page.getByRole('button', { name: 'Diagram', exact: true }).click();
    await expect(page.locator('.be-mermaid svg').first(), 'the sample diagram').toBeVisible({
      timeout: 20_000,
    });
    // a diagram that tries to change its own configuration with a directive
    await page
      .getByRole('textbox', { name: 'Mermaid source' })
      .fill(
        '%%{init: {"securityLevel": "loose", "htmlLabels": true, "theme": "dark"}}%%\n' +
          'flowchart LR\n  Idea --> Plan --> Ship\n  click Ship "javascript:alert(1)"',
      );
    await expect(page.locator('.be-mermaid svg').first(), 'with the directive').toContainText(
      'Ship',
      { timeout: 20_000 },
    );
    await expect(page.locator('.be-mermaid foreignObject'), 'still no HTML labels').toHaveCount(0);

    await page.getByRole('button', { name: 'Kanban', exact: true }).click();
    await expect(page.locator('.be-kanban'), 'the kanban').toBeVisible();
    await page.getByRole('button', { name: 'Story card', exact: true }).click();
    await expect(page.locator('[data-block-type="core.story"]'), 'the story card').toBeVisible();

    expect(
      await page.evaluate(() => (window as unknown as { __violations: unknown[] }).__violations),
      'no securitypolicyviolation event (CSP, Trusted Types)',
    ).toEqual([]);
  });
});
