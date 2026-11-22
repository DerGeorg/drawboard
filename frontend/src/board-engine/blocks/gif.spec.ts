import { GIF_CONSENT_KEY, GifConsent } from '../gifs/gif-consent';
import { GifSlots } from '../gifs/gif-slots';
import { BlockData, Props, GIF_TYPE } from '@apps/drawboard-engine';
import { BlockView } from '../renderer/block-registry';
import { createTestEngine } from '../testing/helpers';
import {
  CONSENT_TEXT,
  DISABLED_TEXT,
  FAILED_TEXT,
  GifServices,
  INVALID_TEXT,
  NEVER_TEXT,
  WAITING_TEXT,
  createGifBlock,
} from './gif';

const aGif = (props: Props, w = 240, id = 'g1'): BlockData => ({
  id,
  type: GIF_TYPE,
  x: 0,
  y: 0,
  w,
  h: 180,
  rotation: 0,
  z: 1,
  parent: null,
  locked: false,
  props,
  hasText: false,
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage;
}

interface Rendered {
  host: HTMLElement;
  view: BlockView;
  img(): HTMLImageElement | null;
}

function setup(services: Partial<GifServices> = {}) {
  const consent = services.consent ?? new GifConsent(memoryStorage());
  const type = createGifBlock({
    enabled: true,
    consent,
    boardKey: () => 'board-1',
    ...services,
  });
  const render = (block: BlockData): Rendered => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = type.render(host, {
      block,
      text: () => '',
      readOnly: false,
      theme: () => 'light',
    });
    view.mounted?.();
    return { host, view, img: () => host.querySelector('img') };
  };
  return { type, consent, render };
}

const text = (host: HTMLElement): string => host.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const clickButton = (host: HTMLElement, label: string): void =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)?.click();

describe('core.gif block', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  describe("without the viewer's consent (G10)", () => {
    it('when no consent was given then a placeholder shows, no image element exists and nothing loads', () => {
      const { render } = setup();

      const { host, img } = render(aGif({ giphyId: 'abc123' }));

      expect(img(), 'no image').toBeNull();
      expect(host.querySelector('[src]'), 'no element with a source').toBeNull();
      expect(text(host), 'text').toContain(CONSENT_TEXT);
      expect(text(host), 'GIPHY named').toContain('GIPHY');
      expect(
        [...host.querySelectorAll('button')].map((b) => b.textContent),
        'buttons',
      ).toEqual(['Load', 'Always in this browser']);
    });

    it('when "Load" is clicked then this board loads the GIF from the GIPHY URL and not before', () => {
      const { render, consent } = setup();
      const { host, img } = render(aGif({ giphyId: 'abc123' }));

      clickButton(host, 'Load');

      expect(consent.allowed('board-1'), 'consent for the board').toBe(true);
      expect(consent.always(), 'not always').toBe(false);
      expect(img()?.getAttribute('src'), 'src').toBe(
        'https://media.giphy.com/media/abc123/200w.webp',
      );
    });

    it('when "Load" is clicked then every GIF block of the board loads, another board does not', () => {
      const { render, consent } = setup();
      const a = render(aGif({ giphyId: 'aaa' }, 240, 'a'));
      const b = render(aGif({ giphyId: 'bbb' }, 240, 'b'));
      const other = setup({ consent, boardKey: () => 'board-2' }).render(aGif({ giphyId: 'ccc' }));

      clickButton(a.host, 'Load');

      expect(a.img()?.src, 'first').toContain('/aaa/');
      expect(b.img()?.src, 'second').toContain('/bbb/');
      expect(other.img(), 'other board').toBeNull();
    });

    it('when "Always in this browser" is clicked then it is stored and loads, and forgetting takes it back', () => {
      const storage = memoryStorage();
      const consent = new GifConsent(storage);
      const { render } = setup({ consent });
      const { host, img } = render(aGif({ giphyId: 'abc123' }));

      clickButton(host, 'Always in this browser');

      expect(storage.getItem(GIF_CONSENT_KEY), 'stored').toBe('always');
      expect(img(), 'loaded').not.toBeNull();

      consent.forget();

      expect(img(), 'image removed').toBeNull();
      expect(text(host), 'placeholder again').toContain(CONSENT_TEXT);
    });

    it('when the block is clicked in its own buttons then the click does not reach the board', () => {
      const { render } = setup();
      const { host } = render(aGif({ giphyId: 'abc123' }));
      const button = host.querySelector('button') as HTMLButtonElement;

      expect(button.hasAttribute('data-be-interactive'), 'marked as its own control').toBe(true);
    });
  });

  describe('with consent', () => {
    function consented() {
      const consent = new GifConsent(memoryStorage());
      consent.allowBoard('board-1');
      return setup({ consent });
    }

    it('when the GIF is shown then the image carries every protective attribute and no srcset', () => {
      const { render } = consented();

      const img = render(aGif({ giphyId: 'abc123', alt: 'A cat' })).img() as HTMLImageElement;

      expect(img.getAttribute('crossorigin'), 'crossorigin').toBe('anonymous');
      expect(img.getAttribute('referrerpolicy'), 'referrerpolicy').toBe('no-referrer');
      expect(img.getAttribute('loading'), 'loading').toBe('lazy');
      expect(img.getAttribute('decoding'), 'decoding').toBe('async');
      expect(img.getAttribute('alt'), 'alt').toBe('A cat');
      expect(img.hasAttribute('srcset'), 'no srcset').toBe(false);
      expect(img.style.objectFit, 'fit').toBe('contain');
    });

    it('when the block is small then the 200 px file is used, when large the original', () => {
      const { render } = consented();

      expect(render(aGif({ giphyId: 'abc' }, 240)).img()?.src, 'small').toBe(
        'https://media.giphy.com/media/abc/200w.webp',
      );
      expect(render(aGif({ giphyId: 'abc' }, 800)).img()?.src, 'large').toBe(
        'https://media.giphy.com/media/abc/giphy.webp',
      );
    });

    it('when the props hold a URL, markup or traversal then nothing is requested', () => {
      const { render } = consented();
      const hostile = [
        'https://evil.example/x.gif',
        '../../secret',
        'a/b',
        '<img src=x onerror=alert(1)>',
        'a b',
        '',
        42,
        null,
        undefined,
      ];

      for (const giphyId of hostile) {
        const { host, img } = render(aGif({ giphyId }));
        expect(img(), String(giphyId)).toBeNull();
        expect(
          host.querySelector('[src],[srcset],[href]'),
          `${String(giphyId)}: no URL anywhere`,
        ).toBeNull();
        expect(text(host), String(giphyId)).toContain(INVALID_TEXT);
      }
    });

    it('when other props carry URLs then none of them reaches the image', () => {
      const { render } = consented();

      const img = render(
        aGif({
          giphyId: 'abc',
          src: 'https://evil.example/a.gif',
          url: 'https://evil.example/b.gif',
          srcset: 'x 1x',
        }),
      ).img() as HTMLImageElement;

      expect(img.src, 'src').toBe('https://media.giphy.com/media/abc/200w.webp');
      expect(img.outerHTML, 'html').not.toContain('evil');
    });

    it('when the alt text has markup then it is only an attribute value, when it breaks the rule it is dropped', () => {
      const { render } = consented();

      const markup = render(aGif({ giphyId: 'abc', alt: '"><script>alert(1)</script>' }));
      const bidi = render(aGif({ giphyId: 'abc', alt: 'evil\u202Etxt' }));
      const long = render(aGif({ giphyId: 'abc', alt: 'x'.repeat(201) }));

      expect(markup.host.querySelectorAll('script').length, 'no script element').toBe(0);
      expect(markup.img()?.alt, 'kept as text').toBe('"><script>alert(1)</script>');
      expect(bidi.img()?.alt, 'bidi').toBe('');
      expect(long.img()?.alt, 'long').toBe('');
    });

    it('when the id changes then the image follows, and the old one is gone', () => {
      const { render } = consented();
      const { view, img, host } = render(aGif({ giphyId: 'aaa' }));

      view.update(aGif({ giphyId: 'bbb' }));

      expect(host.querySelectorAll('img').length, 'one image').toBe(1);
      expect(img()?.src, 'new').toContain('/bbb/');

      view.update(aGif({ giphyId: '../x' }));

      expect(img(), 'invalid id removes the image').toBeNull();
    });

    it('when the image fails then a message shows and it is not retried in a loop', () => {
      const { render } = consented();
      const { host, img } = render(aGif({ giphyId: 'abc' }));

      img()?.dispatchEvent(new Event('error'));

      expect(img(), 'image gone').toBeNull();
      expect(text(host), 'message').toContain(FAILED_TEXT);
    });

    it('when the block is destroyed then the image is removed and its slot given back', () => {
      const slots = new GifSlots(1);
      const consent = new GifConsent(memoryStorage());
      consent.allowBoard('board-1');
      const { render } = setup({ consent, slots });
      const first = render(aGif({ giphyId: 'aaa' }, 240, 'a'));
      expect(slots.loaded, 'one loaded').toBe(1);

      first.view.destroy();

      expect(slots.loaded, 'given back').toBe(0);
      expect(first.img(), 'removed').toBeNull();
    });
  });

  describe('limit and viewport', () => {
    it('when 35 GIFs are shown then 30 load and 5 wait; a freed slot lets one waiting GIF load', () => {
      const consent = new GifConsent(memoryStorage());
      consent.allowBoard('board-1');
      const { render } = setup({ consent });
      const views = Array.from({ length: 35 }, (_, i) =>
        render(aGif({ giphyId: `g${i}` }, 240, `b${i}`)),
      );

      const loaded = (): number => views.filter((v) => v.img()).length;
      expect(loaded(), 'loaded').toBe(30);
      expect(text(views[34].host), 'waiting').toContain(WAITING_TEXT);

      views[0].view.destroy();

      expect(loaded(), 'still 30 after one went and one came').toBe(30);
      expect(views[30].img(), 'the first waiting one loads').not.toBeNull();
    });

    it('when the observer says the block is out of view then the image goes, and returns when it is in view', () => {
      let callback: IntersectionObserverCallback = () => undefined;
      const observe = vi.fn();
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: IntersectionObserverCallback) {
            callback = cb;
          }
          observe = observe;
          disconnect = vi.fn();
        },
      );
      try {
        const consent = new GifConsent(memoryStorage());
        consent.allowBoard('board-1');
        const slots = new GifSlots();
        const { render } = setup({ consent, slots });
        const { img } = render(aGif({ giphyId: 'abc' }));
        const entry = (isIntersecting: boolean): IntersectionObserverEntry =>
          ({ isIntersecting }) as IntersectionObserverEntry;
        expect(observe, 'observed').toHaveBeenCalledTimes(1);
        expect(img(), 'nothing before the observer reports').toBeNull();
        expect(slots.loaded, 'no slot taken yet').toBe(0);
        callback([entry(true)], {} as IntersectionObserver);
        expect(img(), 'in view').not.toBeNull();

        callback([entry(false)], {} as IntersectionObserver);

        expect(img(), 'out of view: no image').toBeNull();
        expect(slots.loaded, 'slot free').toBe(0);

        callback([entry(true)], {} as IntersectionObserver);

        expect(img(), 'back in view').not.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('when a block is mounted outside the viewport with "Always" then no source is set before the observer reports', () => {
      let callback: IntersectionObserverCallback = () => undefined;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: IntersectionObserverCallback) {
            callback = cb;
          }
          observe = vi.fn();
          disconnect = vi.fn();
        },
      );
      try {
        const consent = new GifConsent(memoryStorage());
        consent.allowAlways();
        const { render } = setup({ consent });

        const { host, img } = render(aGif({ giphyId: 'abc' }));

        expect(img(), 'no image element').toBeNull();
        expect(host.querySelector('[src]'), 'no source anywhere').toBeNull();

        callback(
          [{ isIntersecting: false } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
        expect(img(), 'still none when the report says out of view').toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('when the board is zoomed far out then the GIF is a flat box, no view is made', () => {
      const { type } = setup();

      expect(type.simpleFill?.(aGif({ giphyId: 'abc' })), 'a plain colour').toMatch(
        /^#[0-9a-f]{6}$/i,
      );
    });
  });

  describe('never loading', () => {
    it('when the view is a /open link, an export or a thumbnail then it never loads, even with "Always"', () => {
      const consent = new GifConsent(memoryStorage());
      consent.allowAlways();
      const { render } = setup({ consent, mode: 'never' });

      const { host, img } = render(aGif({ giphyId: 'abc123', alt: 'A cat' }));

      expect(img(), 'no image').toBeNull();
      expect(host.querySelector('[src]'), 'no source').toBeNull();
      expect(text(host), 'labelled box').toContain(NEVER_TEXT);
      expect(text(host), 'alt text kept').toContain('A cat');
      expect(host.querySelectorAll('button').length, 'no consent buttons').toBe(0);
    });

    it('when the instance has no GIF switch then it never loads and the data stays', () => {
      const consent = new GifConsent(memoryStorage());
      consent.allowAlways();
      const { render } = setup({ consent, enabled: false });

      const { host, img } = render(aGif({ giphyId: 'abc123' }));

      expect(img(), 'no image').toBeNull();
      expect(text(host), 'text').toContain(DISABLED_TEXT);
    });

    it('when no services are given at all then the block is a placeholder', () => {
      const type = createGifBlock();
      const host = document.createElement('div');

      type.render(host, {
        block: aGif({ giphyId: 'abc' }),
        text: () => '',
        readOnly: false,
        theme: () => 'light',
      });

      expect(host.querySelector('img'), 'no image').toBeNull();
      expect(text(host), 'text').toContain(DISABLED_TEXT);
    });
  });

  describe('in an engine', () => {
    it('when a GIF block is on a board without consent then the board shows the placeholder and creates no image', () => {
      const t = createTestEngine({
        services: {
          gifs: { enabled: true, consent: new GifConsent(memoryStorage()), boardKey: () => 'b' },
        },
      });
      t.engine.insertBlock({
        type: GIF_TYPE,
        at: { x: 100, y: 100 },
        props: { giphyId: 'abc123' },
      });

      expect(t.container.querySelector('img'), 'no image anywhere').toBeNull();
      expect(t.container.textContent, 'placeholder').toContain(CONSENT_TEXT);

      t.destroy();
    });

    it('when consent is given then the board shows the GIF and the registry knows the type as trusted', () => {
      const consent = new GifConsent(memoryStorage());
      const t = createTestEngine({
        services: { gifs: { enabled: true, consent, boardKey: () => 'b' } },
      });
      t.engine.insertBlock({
        type: GIF_TYPE,
        at: { x: 100, y: 100 },
        props: { giphyId: 'abc123' },
      });

      consent.allowBoard('b');

      expect(t.container.querySelector('img')?.getAttribute('src'), 'the GIPHY URL').toBe(
        'https://media.giphy.com/media/abc123/200w.webp',
      );
      expect(t.engine.registry.get(GIF_TYPE)?.trusted, 'trusted built-in').toBe(true);

      t.destroy();
    });
  });
});
