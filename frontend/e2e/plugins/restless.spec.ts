import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RECORD_VIOLATIONS, appCsp } from '../support/csp';

/**
 * More negative tests of the plugin sandbox (M3 frontend review: "Add ... a self-navigating
 * frame, a 10 MB message"). Same harness as sandbox.spec.ts: the real engine and PluginHost,
 * the frame document with the backend's headers, no backend, no login.
 */
const APP = 'https://app.test';
const PLUGIN_ID = 'org.restless.sandbox';
const ASSET_PATH = `/plugin-assets/${PLUGIN_ID}/1.0.0/${'f'.repeat(64)}/`;
const SOURCE = `${APP}${ASSET_PATH}`;
const FRAME_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src ${SOURCE}`,
  `style-src ${SOURCE} 'unsafe-inline'`,
  `img-src ${SOURCE} data: blob:`,
  `font-src ${SOURCE}`,
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  `frame-ancestors ${APP}`,
].join('; ');
const APP_CSP = appCsp();

let hostJs = '';
const pluginJs = readFileSync(join(__dirname, 'restless-plugin.js'));

test.describe('plugin sandbox: a restless plugin', () => {
  test.beforeAll(async () => {
    const result = await build({
      entryPoints: [join(__dirname, 'harness-host.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'error',
    });
    hostJs = result.outputFiles[0]?.text ?? '';
  });

  test('when a plugin floods its port and navigates its frame then the board stays and the plugin stops', async ({
    page,
    context,
  }) => {
    const reports = new Map<string, unknown>();
    let frameLoads = 0;
    await context.route(`${APP}/**`, (route) => {
      const url = new URL(route.request().url());
      const frame = (body: string) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          headers: { 'Content-Security-Policy': FRAME_CSP, 'X-Content-Type-Options': 'nosniff' },
          body,
        });
      switch (url.pathname) {
        case '/':
          return route.fulfill({
            contentType: 'text/html',
            headers: { 'Content-Security-Policy': APP_CSP },
            body:
              `<!doctype html><title>Board</title><script type="application/json" id="config">` +
              `${JSON.stringify({ pluginId: PLUGIN_ID, assetBase: ASSET_PATH, entry: 'restless.js' })}</script>` +
              '<div id="board" style="width:900px;height:600px"></div>' +
              '<script type="module" src="/host.js"></script>',
          });
        case '/host.js':
          return route.fulfill({ contentType: 'text/javascript', body: hostJs });
        case `${ASSET_PATH}__drawboard/frame.html`:
          frameLoads++;
          return frame(
            `<!doctype html><script type="module" src="${ASSET_PATH}restless.js"></script>`,
          );
        case `${ASSET_PATH}elsewhere.html`:
          // where the frame navigates to: it waits for a second port that must never come
          return frame(`<!doctype html><script src="${ASSET_PATH}elsewhere.js"></script>`);
        case `${ASSET_PATH}elsewhere.js`:
          return route.fulfill({
            contentType: 'text/javascript',
            body:
              `const r = (n) => { const i = new Image(); i.src = '${SOURCE}report.png?' + n + '=1'; };` +
              "r('elsewhere'); window.addEventListener('message', (e) => { if (e.ports.length) r('secondPort'); });",
          });
        case `${ASSET_PATH}restless.js`:
          return route.fulfill({
            contentType: 'text/javascript',
            headers: { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' },
            body: pluginJs,
          });
        case `${ASSET_PATH}report.png`:
          for (const [name, value] of url.searchParams) {
            reports.set(name, JSON.parse(value) as unknown);
          }
          return route.fulfill({ status: 204 });
        default:
          return route.fulfill({ status: 404 });
      }
    });

    await page.addInitScript(RECORD_VIOLATIONS);
    await page.goto(`${APP}/`);
    await expect
      .poll(() => reports.has('flooded'), {
        message: 'the 10 MB message went out',
        timeout: 10_000,
      })
      .toBe(true);
    const before = await page.evaluate(() => window.harness.beats?.() ?? 0);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const after = await page.evaluate(() => window.harness.beats?.() ?? 0);
    expect(after - before, 'the board kept running (about 10 beats in 500 ms)').toBeGreaterThan(5);
    expect(reports.has('reply-big'), 'the oversized message got no answer').toBe(false);

    await expect
      .poll(() => reports.has('elsewhere'), { message: 'the frame navigated', timeout: 10_000 })
      .toBe(true);
    await expect(page.locator('iframe.be-plugin-frame'), 'its frame is gone').toHaveCount(0);
    await expect(
      page.locator(`.be-block[data-block-type="${PLUGIN_ID}.block"]`),
      'the block says why',
    ).toContainText('navigated itself');
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(reports.has('secondPort'), 'no second port').toBe(false);
    expect(frameLoads, 'not started again').toBe(1);
    const props = await page.evaluate(() => window.harness.props(window.harness.blockIds.own));
    expect(props, 'nothing written').toEqual({ mine: true });
    expect(
      await page.evaluate(() => (window as unknown as { __violations: unknown[] }).__violations),
      'no securitypolicyviolation event in the app page',
    ).toEqual([]);
  });
});
