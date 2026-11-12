import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { RECORD_VIOLATIONS, appCsp } from '../support/csp';

/**
 * Mermaid (S5.1) and pdf.js (S4.9) in a real browser under the app's production CSP (S7.5,
 * deploy/nginx, read from the template) with enforced Trusted Types (S3.12): no eval, the pdf.js
 * worker from our own origin as a Trusted Types script URL, nothing blocked - not a single
 * `securitypolicyviolation` event. Kanban and story cards are on the same board. No backend:
 * the test serves the page, the bundles and a two-page PDF itself.
 */
const APP = 'https://app.test';
const CSP = appCsp();
const ROOT = join(__dirname, '../..');
const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};

/** A minimal two-page PDF with text (built here, no binary fixture in the repository). */
function twoPagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    null,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = (text: string) => {
    const content = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
    return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  };
  objects[3] = stream('Page one');
  objects[5] = stream('Page two');
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test.describe('rich content under the production CSP', () => {
  const bundle = new Map<string, Uint8Array>();

  test.beforeAll(async () => {
    const result = await build({
      entryPoints: { host: join(__dirname, 'content-host.ts') },
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outdir: '/bundle',
      write: false,
      logLevel: 'error',
    });
    for (const file of result.outputFiles) {
      bundle.set(file.path.replace(/^.*\/bundle\//, '/'), file.contents);
    }
  });

  test('when a diagram and a PDF are on the board then both render without any CSP violation', async ({
    page,
    context,
  }) => {
    const violations: string[] = [];
    const fileRequests: string[] = [];
    await page.addInitScript(RECORD_VIOLATIONS);
    page.on('console', (m) => {
      if (/Content.Security.Policy|unsafe-eval|Refused to/i.test(m.text())) {
        violations.push(m.text());
      }
    });
    const workerRequests: string[] = [];
    await context.route(`${APP}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/pdfjs/pdf.worker.min.mjs') {
        workerRequests.push(route.request().url());
      }
      if (path === '/') {
        return route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': CSP },
          body:
            '<!doctype html><title>Content</title>' +
            '<div id="board" style="width:1400px;height:1400px;position:relative"></div>' +
            '<script type="module" src="/host.js"></script>',
        });
      }
      if (bundle.has(path)) {
        return route.fulfill({
          contentType: 'text/javascript',
          body: Buffer.from(bundle.get(path) as Uint8Array),
        });
      }
      if (path.startsWith('/pdfjs/')) {
        const rel = path.slice('/pdfjs/'.length);
        const source = rel === 'pdf.worker.min.mjs' ? `build/${rel}` : rel;
        try {
          return route.fulfill({
            contentType: TYPES[extname(rel)] ?? 'application/octet-stream',
            headers: { 'Content-Security-Policy': CSP },
            body: readFileSync(join(ROOT, 'node_modules/pdfjs-dist', source)),
          });
        } catch {
          return route.fulfill({ status: 404 });
        }
      }
      if (path.startsWith('/files/')) {
        fileRequests.push(route.request().url());
        return route.fulfill({ contentType: 'application/pdf', body: twoPagePdf() });
      }
      return route.fulfill({ status: 404 });
    });

    await page.goto(`${APP}/`);
    expect(
      await page.evaluate(() => {
        try {
          document.createElement('div').innerHTML = '<b>x</b>';
          return 'allowed';
        } catch (e) {
          return (e as Error).name;
        }
      }),
      'Trusted Types are enforced: a raw string is refused by the default policy',
    ).toBe('TypeError');

    const svg = page.locator('.be-mermaid svg');
    await expect(svg, 'the diagram rendered').toBeVisible({ timeout: 15_000 });
    await expect(svg, 'its labels').toContainText('Ship');
    // Playwright's CSS engine pierces open shadow roots, so the selectors here and below still
    // match; the diagram itself must sit in the shadow root of its holder (review finding 5)
    expect(
      await page
        .locator('.be-mermaid-diagram')
        .evaluate((el) => el.shadowRoot?.querySelector('svg') != null && !el.querySelector('svg')),
      'the SVG is scoped by a shadow root',
    ).toBe(true);
    await expect(page.locator('.be-mermaid foreignObject'), 'no HTML labels (S5.1)').toHaveCount(0);
    await expect(page.locator('.be-mermaid a'), 'no links (S5.1)').toHaveCount(0);
    await expect(
      page.locator('.be-mermaid svg [onclick], .be-mermaid svg [href^="javascript"]'),
      'no handlers',
    ).toHaveCount(0);

    const canvases = page.locator('canvas.be-pdf-page');
    await expect(canvases, 'both PDFs rendered').toHaveCount(2, { timeout: 15_000 });
    const canvas = canvases.first();
    await expect(canvas, 'the PDF page rendered').toBeVisible();
    await expect(page.locator('.be-pdf-label').first(), 'pager').toHaveText('1 / 2');
    await page.getByRole('button', { name: 'Next page of doc.pdf' }).first().click();
    await expect(page.locator('.be-pdf-label').first(), 'second page').toHaveText('2 / 2');
    await expect(page.locator('.be-pdf-label').nth(1), 'the other PDF stays').toHaveText('1 / 2');
    expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width), 'rendered width').toBe(1200);
    expect(fileRequests, 'each PDF was fetched once').toHaveLength(2);
    expect(workerRequests, 'one worker file, from our origin').toEqual([
      `${APP}/pdfjs/pdf.worker.min.mjs`,
    ]);

    await expect(page.locator('.be-kanban'), 'the kanban').toBeVisible();
    await expect(page.locator('.be-kanban [data-column-id]'), 'its columns').toHaveCount(3);
    await expect(page.locator('[data-block-type="core.story"]'), 'the story card').toContainText(
      'As a user I can sign in',
    );

    expect(violations, 'no CSP violation, no eval').toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __violations: unknown[] }).__violations),
      'no securitypolicyviolation event (CSP, Trusted Types)',
    ).toEqual([]);
  });
});
