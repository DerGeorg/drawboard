import { Page } from '@playwright/test';
import * as Y from 'yjs';

/** The id of the one GIF on the test board; the URL of its image is built from it. */
export const GIF_ID = 'xT9IgDEI1iZyb2wqo8';
export const GIF_URL = `https://media.giphy.com/media/${GIF_ID}/200w.webp`;

/** A 4 x 4 PNG: the stand-in for what GIPHY would send. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGOosXoLRwzEcQCiIhoxc/GUzgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Stands in for GIPHY: every request to media.giphy.com is answered here, none ever leaves the
 * browser. Returns the list of URLs that were asked for.
 */
export async function mockGiphy(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route('https://media.giphy.com/**', (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
      body: PIXEL,
    });
  });
  return requests;
}

/** A board (Y.Doc of architecture 3.3) holding one GIF block and a sticky for company. */
export function boardWithGif(): Uint8Array {
  const doc = new Y.Doc();
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  doc.getMap('meta').set('schemaVersion', 1);
  const add = (
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    props: object,
    text?: string,
  ): void => {
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
      z: blocks.size,
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
    add('core.gif', 100, 100, 240, 180, { giphyId: GIF_ID, alt: 'A cat on a keyboard' });
    add('core.sticky', 400, 100, 160, 160, { color: '#fde68a' }, 'Beside the GIF');
  });
  return Y.encodeStateAsUpdate(doc);
}
