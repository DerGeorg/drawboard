import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RECORD_VIOLATIONS, appCsp } from '../support/csp';

/**
 * Negative tests of the plugin sandbox in a real browser ("Before enabling in production":
 * a plugin provably cannot read `parent`, fetch `/api`, navigate the top window, open a popup
 * or write props of foreign blocks). No backend and no login: the test serves the board page
 * (the real engine and PluginHost, bundled here), the frame document with exactly the headers
 * the backend generates (FrameDocuments: sandbox CSP, frame-ancestors, nosniff) and a hostile
 * plugin that tries everything and reports through images from its own asset base.
 */
const APP = 'https://app.test';
const EVIL = 'https://evil.test';
const PLUGIN_ID = 'org.evil.sandbox';
const ASSET_PATH = `/plugin-assets/${PLUGIN_ID}/1.0.0/${'e'.repeat(64)}/`;
const SOURCE = `${APP}${ASSET_PATH}`;

/** The CSP of the generated frame document (backend FrameDocuments, S3.3 as refined in M3). */
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

/** The app's CSP as nginx sends it, read from the template (S7.5, S3.12 Trusted Types). */
const APP_CSP = appCsp();

let hostJs = '';
const evilJs = readFileSync(join(__dirname, 'evil-plugin.js'));
const integrity = `sha384-${createHash('sha384').update(evilJs).digest('base64')}`;

test.describe('plugin sandbox', () => {
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

  test('when a hostile plugin runs then it reaches nothing outside its frame', async ({
    page,
    context,
  }) => {
    const reports = new Map<string, { ok?: boolean; value?: unknown; error?: string }>();
    const apiRequests: string[] = [];
    const foreignRequests: string[] = [];
    await context.addCookies([{ name: 'session', value: 'secret-cookie', url: APP }]);

    await context.route(`${EVIL}/**`, (route) => {
      foreignRequests.push(route.request().url());
      return route.fulfill({ status: 200, body: 'pwned' });
    });
    await context.route(`${APP}/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': APP_CSP },
          body:
            `<!doctype html><title>Board</title><script type="application/json" id="config">` +
            `${JSON.stringify({ pluginId: PLUGIN_ID, assetBase: ASSET_PATH })}</script>` +
            '<div id="board" style="width:900px;height:600px"></div>' +
            '<script type="module" src="/host.js"></script>',
        });
      }
      if (url.pathname === '/host.js') {
        return route.fulfill({ contentType: 'text/javascript', body: hostJs });
      }
      if (url.pathname === `${ASSET_PATH}__drawboard/frame.html`) {
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          headers: {
            'Content-Security-Policy': FRAME_CSP,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          },
          body:
            '<!doctype html><meta charset="utf-8">' +
            `<script type="module" src="${ASSET_PATH}evil.js" integrity="${integrity}" crossorigin="anonymous"></script>`,
        });
      }
      if (url.pathname === `${ASSET_PATH}evil.js`) {
        return route.fulfill({
          contentType: 'text/javascript',
          headers: { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' },
          body: evilJs,
        });
      }
      if (url.pathname === `${ASSET_PATH}report.png`) {
        for (const [name, value] of url.searchParams) {
          reports.set(name, JSON.parse(value) as { ok?: boolean });
        }
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      if (url.pathname.startsWith('/api/')) {
        apiRequests.push(url.pathname);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 404 });
    });

    await page.addInitScript(RECORD_VIOLATIONS);
    await page.goto(`${APP}/`);
    const frame = page.locator('iframe.be-plugin-frame');
    await expect(frame, 'the plugin frame').toHaveCount(1);
    await expect(frame, 'only scripts').toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame, 'no permissions').toHaveAttribute('allow', '');
    await expect(frame, 'no referrer').toHaveAttribute('referrerpolicy', 'no-referrer');

    await expect
      .poll(() => [...reports.keys()].sort(), { message: 'all attempts reported', timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          'cookie',
          'localStorage',
          'parentDocument',
          'parentLocation',
          'popup',
          'topNavigation',
          'fetchApi',
          'fetchForeign',
          'init',
          'reply-p1',
          'reply-p2',
        ]),
      );

    expect(JSON.stringify(reports.get('cookie')), 'no cookie of the app').not.toContain('secret');
    expect(reports.get('localStorage')?.ok, 'no storage of the app').toBe(false);
    expect(reports.get('parentDocument')?.ok, 'cannot read parent').toBe(false);
    expect(reports.get('parentLocation')?.ok, 'cannot read the parent URL').toBe(false);
    expect(
      reports.get('popup')?.ok === false || reports.get('popup')?.value === 'blocked',
      'no popup',
    ).toBe(true);
    expect(reports.get('topNavigation')?.ok, 'cannot navigate the top window').toBe(false);
    expect(page.url(), 'the board stays').toBe(`${APP}/`);
    expect(reports.get('fetchApi')?.ok, 'cannot fetch /api').toBe(false);
    expect(apiRequests, 'no request reached /api').toEqual([]);
    expect(reports.get('fetchForeign')?.ok, 'cannot fetch elsewhere').toBe(false);
    expect(foreignRequests, 'nothing reached a foreign host').toEqual([]);
    expect(reports.get('init'), 'the pseudonym, never a user id').toEqual({
      user: { id: 'x'.repeat(43), name: 'Alice', guest: false },
      capabilities: [],
    });
    expect(reports.get('reply-p1'), 'props without the grant').toEqual({
      type: 'error',
      code: 'CAPABILITY_NOT_GRANTED',
    });
    expect(reports.get('reply-p2'), 'a foreign block cannot be named').toEqual({
      type: 'error',
      code: 'INVALID_PAYLOAD',
    });

    const props = await page.evaluate(() => ({
      own: window.harness.props(window.harness.blockIds.own),
      other: window.harness.props(window.harness.blockIds.other),
    }));
    expect(props, 'no block was written (also not by the spoofed window message)').toEqual({
      own: { mine: true },
      other: { color: '#fde68a' },
    });
    expect(context.pages(), 'no popup page').toHaveLength(1);
    // the app page itself - enforced CSP and Trusted Types - saw no violation while the plugin
    // block ran (the plugin's own attempts are blocked inside its frame)
    expect(
      await page.evaluate(() => (window as unknown as { __violations: unknown[] }).__violations),
      'no securitypolicyviolation event in the app page',
    ).toEqual([]);
  });
});
