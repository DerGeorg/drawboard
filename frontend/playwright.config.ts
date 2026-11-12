import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env['CI'];

/**
 * End-to-end tests against the BUILT IMAGE (nginx: runtime config, /api and /faro proxies),
 * backend and Keycloak of the backend dev stack. Local default: the image on port 18090
 * (README.md, "End-to-end tests"). E2E_BASE_URL=http://localhost:4200 runs against ng serve.
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:18090';

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'junit/e2e-results.xml' }],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: /(plugins|content|guests|headers)\//,
    },
    // in a real browser without backend or login: the plugin sandbox (e2e/plugins), Mermaid
    // and pdf.js under the production CSP (e2e/content), and the nginx security headers checked
    // against architecture S7.5 (e2e/headers, no browser needed)
    {
      name: 'sandbox',
      testMatch: /(plugins|content|headers)\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // the served app (image or ng serve) WITHOUT backend and login: every /api call is mocked
    // with page.route - guests and their allowlist (e2e/guests)
    {
      name: 'mocked',
      testMatch: /guests\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
