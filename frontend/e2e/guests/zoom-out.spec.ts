import { Page, expect, test } from '@playwright/test';
import * as Y from 'yjs';

import { MockCollabSocket } from '../support/collab-socket';
import { openGuestBoard } from '../support/guest-board';

/**
 * Far zoomed out in a real browser: a board of 5000 blocks served by the mocked collaboration
 * socket, zoomed to 2 %. The assertions are about what is in the DOM (plain boxes, no text, no
 * grid); the timings are measured and attached to the report, never asserted (CI runners are
 * about ten times slower).
 */

const COLUMNS = 100;
const ROWS = 50;
const STICKY_COLORS = ['#fde68a', '#fecdd3', '#bae6fd', '#bbf7d0'];

/** The Y.Doc of architecture 3.3 with 5000 blocks: stickies, shapes, text and a frame per row. */
function bigBoard(): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  doc.getMap('meta').set('schemaVersion', 1);
  let z = 0;
  const add = (
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    props: object,
    text?: string,
  ) => {
    const id = crypto.randomUUID();
    const m = new Y.Map<unknown>();
    blocks.set(id, m);
    for (const [k, v] of Object.entries({
      id,
      type,
      x,
      y,
      w,
      h,
      rotation: 0,
      z: ++z,
      parent: null,
      locked: false,
    })) {
      m.set(k, v);
    }
    const p = new Y.Map<unknown>();
    m.set('props', p);
    for (const [k, v] of Object.entries(props)) {
      p.set(k, v);
    }
    if (text !== undefined) {
      const t = new Y.Text();
      m.set('text', t);
      t.insert(0, text);
    }
  };
  doc.transact(() => {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLUMNS; col++) {
        const x = col * 260;
        const y = row * 260;
        const i = row * COLUMNS + col;
        if (col === 0) {
          add('core.frame', x, y, 240, 240, { fill: '#ffffff' }, `Row ${row}`);
        } else if (i % 5 === 0) {
          add(
            'core.shape',
            x,
            y,
            220,
            140,
            { kind: 'rect', fill: '#bae6fd', stroke: '#334155', strokeWidth: 2 },
            'Shape',
          );
        } else if (i % 7 === 0) {
          add('core.text', x, y, 220, 60, { color: '#0f172a' }, `Text ${i}`);
        } else {
          add(
            'core.sticky',
            x,
            y,
            200,
            200,
            { color: STICKY_COLORS[i % 4] },
            `Note ${i} with a few words`,
          );
        }
      }
    }
  });
  return Y.encodeStateAsUpdate(doc);
}

interface Timing {
  median: number;
  p95: number;
  max: number;
  /** The slowest step and the zoom (in %) it ended at. */
  slowestAt: number;
}

/** Runs `steps` actions in the page, each followed by two frames; ms per step. */
async function measure(
  page: Page,
  action: 'zoomOut' | 'pan' | 'wheelZoom',
  steps: number,
): Promise<Timing> {
  return page.evaluate(
    async ({ action, steps }) => {
      const world = document.querySelector('.be-world') as HTMLElement;
      const surface = world.parentElement as HTMLElement;
      const r = surface.getBoundingClientRect();
      const frame = () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );
      const times: number[] = [];
      const zoomLabel = document.querySelector('[aria-label="Reset zoom to 100%"]');
      let slowest = { ms: 0, at: 0 };
      for (let i = 0; i < steps; i++) {
        const t0 = performance.now();
        if (action === 'zoomOut') {
          window.dispatchEvent(
            new KeyboardEvent('keydown', { key: '-', code: 'Minus', ctrlKey: true, bubbles: true }),
          );
        } else {
          surface.dispatchEvent(
            new WheelEvent('wheel', {
              deltaX: action === 'pan' ? 40 : 0,
              deltaY: action === 'pan' ? 25 : i % 2 === 0 ? -20 : 20,
              ctrlKey: action === 'wheelZoom',
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        await frame();
        const ms = performance.now() - t0;
        times.push(ms);
        if (ms > slowest.ms) {
          slowest = { ms, at: parseInt(zoomLabel?.textContent ?? '0', 10) };
        }
      }
      times.sort((a, b) => a - b);
      const at = (q: number) =>
        Math.round((times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0) * 10) /
        10;
      return { median: at(0.5), p95: at(0.95), max: at(1), slowestAt: slowest.at };
    },
    { action, steps },
  );
}

test.describe('zoomed out to 2 %', () => {
  test('when a board of 5000 blocks is zoomed out to 2 % then every block is a plain box and panning stays light', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const collab = new MockCollabSocket({ snapshot: bigBoard() });
    await openGuestBoard(page, { collab });
    await expect(page.getByText('Row 0', { exact: true }), 'board loaded').toBeVisible({
      timeout: 30_000,
    });
    const mountedAt100 = await page.locator('.be-block').count();

    // 100 % -> 2 %: 18 steps of 1.25
    const zoomOut = await measure(page, 'zoomOut', 18);
    await expect(page.getByRole('button', { name: 'Reset zoom to 100%' }), 'zoom pill').toHaveText(
      '2%',
    );

    await expect(page.locator('.be-block'), 'all mounted').toHaveCount(COLUMNS * ROWS);
    await expect(page.locator('.be-block[data-lod="simple"]'), 'all simple').toHaveCount(
      COLUMNS * ROWS,
    );
    await expect(page.locator('.be-world .be-text'), 'no text views').toHaveCount(0);
    await expect(
      page.locator('.be-world svg'),
      'no shape SVGs (only the connector layer)',
    ).toHaveCount(1);
    await expect(
      page.locator('.be-simple-title', { hasText: /^Row 0$/ }),
      'frame titles stay',
    ).toHaveCount(1);
    const grid = await page
      .locator('[data-testid="canvas"] .be-world')
      .evaluate((w) => (w.parentElement as HTMLElement).style.backgroundImage);
    expect(grid, 'no dot grid').toBe('none');
    const elements = await page.locator('.be-world *').count();

    const pan = await measure(page, 'pan', 60);
    const wheelZoom = await measure(page, 'wheelZoom', 40);
    const report = {
      blocks: COLUMNS * ROWS,
      mountedAt100,
      elementsAt2: elements,
      zoomOut,
      pan,
      wheelZoom,
    };
    test.info().annotations.push({
      type: 'performance (ms per step incl. 2 frames)',
      description: JSON.stringify(report),
    });
    console.log('zoom-out performance', JSON.stringify(report));
  });
});
