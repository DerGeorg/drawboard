import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Gif, GifPage } from '@apps/drawboard-api';

import { GIF_CONSENT_KEY } from '../../../../board-engine/gifs/gif-consent';
import { GifConsentStore } from '../../../services/gif-consent';
import { ApiError } from '../../../util/api-error';
import { all, buttonByText, textOf } from '../../../test/dom';
import { aProblem } from '../../../test/fixtures';
import { GifPicker } from './gif-picker';
import { GifSearch, SEARCH_DEBOUNCE_MS } from './gif-search';

const gif = (id: string, title = `GIF ${id}`): Gif => ({ id, title, width: 4, height: 3 });
const page = (ids: string[], hasMore = false): GifPage => ({
  items: ids.map((i) => gif(i)),
  hasMore,
});

function apiError(status: number, code: string, retryAfter?: string): ApiError {
  const headers = new HttpHeaders(retryAfter ? { 'Retry-After': retryAfter } : {});
  return new ApiError(
    aProblem({ status, code }),
    undefined,
    new HttpErrorResponse({ status, headers }),
  );
}

describe('GifPicker', () => {
  let fixture: ComponentFixture<GifPicker>;
  let picked: Gif[];
  let closed: number;
  let search: {
    search: ReturnType<typeof vi.fn<(q: string, page: number) => Promise<GifPage>>>;
    trending: ReturnType<typeof vi.fn<() => Promise<GifPage>>>;
    disabled: ReturnType<typeof import('@angular/core').signal<boolean>>;
  };

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(GifPicker);
    fixture.componentRef.setInput('boardKey', 'board-1');
    picked = [];
    closed = 0;
    fixture.componentInstance.picked.subscribe((g) => picked.push(g));
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
  }

  const field = (): HTMLInputElement =>
    all<HTMLInputElement>(fixture, 'input[type=search]')[0] as HTMLInputElement;
  const images = (): HTMLImageElement[] => all<HTMLImageElement>(fixture, 'img');
  async function type(value: string): Promise<void> {
    field().value = value;
    field().dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }
  async function pause(ms = SEARCH_DEBOUNCE_MS): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await fixture.whenStable();
  }
  const consent = (): GifConsentStore => TestBed.inject(GifConsentStore);

  beforeEach(async () => {
    localStorage.clear();
    const { signal } = await import('@angular/core');
    search = {
      search: vi
        .fn<(q: string, page: number) => Promise<GifPage>>()
        .mockResolvedValue(page(['s1', 's2'], true)),
      trending: vi.fn<() => Promise<GifPage>>().mockResolvedValue(page(['t1', 't2', 't3'])),
      disabled: signal(false),
    };
    TestBed.configureTestingModule({ providers: [{ provide: GifSearch, useValue: search }] });
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  describe('consent first (G10)', () => {
    it('when the viewer has not agreed then the notice shows and no request and no image exist', async () => {
      await render();

      expect(textOf(fixture), 'notice').toContain('sends your IP address to GIPHY');
      expect(images().length, 'no preview').toBe(0);
      expect(field(), 'no search field yet').toBeUndefined();
      expect(search.trending, 'no trending call').not.toHaveBeenCalled();
      expect(search.search, 'no search call').not.toHaveBeenCalled();
    });

    it('when "Load" is clicked then trending shows with GIPHY previews, nothing is stored', async () => {
      await render();

      buttonByText(fixture, 'Load').click();
      await fixture.whenStable();

      expect(search.trending, 'trending once').toHaveBeenCalledTimes(1);
      expect(
        images().map((i) => i.getAttribute('src')),
        'previews',
      ).toEqual([
        'https://media.giphy.com/media/t1/200w.webp',
        'https://media.giphy.com/media/t2/200w.webp',
        'https://media.giphy.com/media/t3/200w.webp',
      ]);
      expect(localStorage.getItem(GIF_CONSENT_KEY), 'nothing stored').toBeNull();
      expect(consent().allowed('board-1'), 'this board').toBe(true);
      expect(consent().allowed('board-2'), 'another board').toBe(false);
    });

    it('when "Always in this browser" is clicked then it is stored and previews show', async () => {
      await render();

      buttonByText(fixture, 'Always in this browser').click();
      await fixture.whenStable();

      expect(localStorage.getItem(GIF_CONSENT_KEY), 'stored').toBe('always');
      expect(images().length, 'previews').toBe(3);
    });

    it('when the consent exists already then trending shows at once without asking', async () => {
      consent().allowBoard('board-1');

      await render();

      expect(textOf(fixture), 'no notice').not.toContain('sends your IP address');
      expect(search.trending, 'trending asked once').toHaveBeenCalledTimes(1);
      expect(images().length, 'previews shown').toBe(3);
    });

    it('when the consent was given elsewhere (a GIF block) while the picker is open then trending loads', async () => {
      await render();

      consent().allowBoard('board-1');
      await fixture.whenStable();

      expect(search.trending, 'trending asked once').toHaveBeenCalledTimes(1);
    });

    it('when the picker shows previews then every image carries the protective attributes', async () => {
      consent().allowAlways();
      await render();

      const img = images()[0] as HTMLImageElement;

      expect(img.getAttribute('crossorigin'), 'crossorigin').toBe('anonymous');
      expect(img.getAttribute('referrerpolicy'), 'referrer').toBe('no-referrer');
      expect(img.getAttribute('loading'), 'lazy').toBe('lazy');
      expect(img.hasAttribute('srcset'), 'srcset').toBe(false);
    });
  });

  describe('searching (G7)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      consent().allowAlways();
    });

    it('when keys are typed in a burst then exactly one search goes out after the pause', async () => {
      await render();
      search.trending.mockClear();

      for (const text of ['c', 'ca', 'cat', 'cats']) {
        await type(text);
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(search.search, 'nothing during the burst').not.toHaveBeenCalled();

      await pause();

      expect(search.search, 'one search').toHaveBeenCalledTimes(1);
      expect(search.search, 'the searched text').toHaveBeenCalledWith('cats', 0);
      expect(images().length, 'results').toBe(2);
    });

    it('when the debounce is configured then it is at least 400 ms', () => {
      expect(SEARCH_DEBOUNCE_MS, 'debounce').toBeGreaterThanOrEqual(400);
    });

    it('when only one character is typed then no request goes out and the hint shows', async () => {
      await render();
      search.trending.mockClear();

      await type('c');
      await pause(2000);

      expect(search.search, 'no search').not.toHaveBeenCalled();
      expect(search.trending, 'no trending').not.toHaveBeenCalled();
      expect(textOf(fixture), 'hint').toContain('at least 2 characters');
    });

    it('when the text is only blanks then it counts as empty and shows trending', async () => {
      await render();
      await type('cat');
      await pause();
      search.trending.mockClear();

      await type('   ');
      await fixture.whenStable();

      expect(search.trending, 'trending').toHaveBeenCalledTimes(1);
    });

    it('when the text has extra blanks then the trimmed, collapsed text is sent', async () => {
      await render();

      await type('  happy    cat ');
      await pause();

      expect(search.search, 'the cleaned text').toHaveBeenCalledWith('happy cat', 0);
    });

    it('when the user pages on then the next page is asked, and page 9 has no next', async () => {
      search.search.mockResolvedValue(page(['p'], true));
      await render();
      await type('cat');
      await pause();

      (
        all<HTMLButtonElement>(fixture, 'button[aria-label="Next page"]')[0] as HTMLButtonElement
      ).click();
      await fixture.whenStable();
      expect(search.search, 'second page').toHaveBeenLastCalledWith('cat', 1);

      for (let p = 2; p <= 9; p++) {
        (
          all<HTMLButtonElement>(fixture, 'button[aria-label="Next page"]')[0] as HTMLButtonElement
        ).click();
        await fixture.whenStable();
      }
      expect(search.search, 'page 9').toHaveBeenLastCalledWith('cat', 9);
      expect(
        (all<HTMLButtonElement>(fixture, 'button[aria-label="Next page"]')[0] as HTMLButtonElement)
          .disabled,
        'no next after page 9',
      ).toBe(true);
      expect(textOf(fixture), 'page number').toContain('Page 10');
    });

    it('when an old answer arrives after a newer search then it is ignored', async () => {
      let first: (p: GifPage) => void = () => undefined;
      search.search.mockImplementationOnce(() => new Promise<GifPage>((r) => (first = r)));
      search.search.mockResolvedValueOnce(page(['new1']));
      await render();

      await type('aaa');
      await pause();
      await type('bbb');
      await pause();
      first(page(['old1', 'old2']));
      await fixture.whenStable();

      expect(
        images().map((i) => i.src),
        'only the newer result',
      ).toEqual(['https://media.giphy.com/media/new1/200w.webp']);
    });
  });

  describe('picking', () => {
    beforeEach(() => consent().allowAlways());

    it('when a GIF is clicked then it is handed on with its id', async () => {
      await render();

      (
        all<HTMLButtonElement>(fixture, 'button[aria-label="GIF t2"]')[0] as HTMLButtonElement
      ).click();

      expect(
        picked.map((g) => g.id),
        'the picked id',
      ).toEqual(['t2']);
    });

    it('when the answer holds a bad id then that GIF is not shown at all', async () => {
      search.trending.mockResolvedValue(page(['good', '../evil', 'https://evil.example/x', '']));

      await render();

      expect(
        images().map((i) => i.src),
        'only the valid id',
      ).toEqual(['https://media.giphy.com/media/good/200w.webp']);
    });

    it('when a title has bidi characters then the label is cleaned', async () => {
      search.trending.mockResolvedValue({ items: [gif('x1', 'a\u202Eb\nc')], hasMore: false });

      await render();

      expect(all(fixture, 'button[aria-label="a b c"]').length, 'cleaned label').toBe(1);
    });

    it('when the picker is open then "Powered by GIPHY" is visible as text', async () => {
      await render();

      expect(textOf(fixture), 'powered by text').toContain('Powered by GIPHY');
    });

    it('when Escape is pressed then the picker asks to be closed', async () => {
      await render();

      (fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );

      expect(closed, 'closed once').toBe(1);
    });
  });

  describe('errors (no toast flood)', () => {
    beforeEach(() => consent().allowAlways());

    it('when the instance has no GIFs (404 GIFS_DISABLED) then the picker asks to be closed', async () => {
      search.trending.mockRejectedValue(apiError(404, 'GIFS_DISABLED'));

      await render();

      expect(closed, 'closed').toBe(1);
    });

    it('when the user limit is hit (429 TOO_MANY_REQUESTS) then the wait from Retry-After shows', async () => {
      search.trending.mockRejectedValue(apiError(429, 'TOO_MANY_REQUESTS', '20'));

      await render();

      expect(textOf(fixture), 'text').toContain(
        'You are searching too fast. Try again in 20 seconds.',
      );
      expect(all(fixture, '[role=alert]').length, 'one alert').toBe(1);
    });

    it('when the instance budget is used up (429 GIFS_BUDGET_EXHAUSTED) then the text says so with the wait', async () => {
      search.trending.mockRejectedValue(apiError(429, 'GIFS_BUDGET_EXHAUSTED', '900'));

      await render();

      expect(textOf(fixture), 'text').toContain('used up for now. Try again in 15 minutes.');
    });

    it('when GIPHY is down (503) then the text says so', async () => {
      search.trending.mockRejectedValue(apiError(503, 'GIFS_UNAVAILABLE'));

      await render();

      expect(textOf(fixture), 'text').toContain('GIPHY cannot be reached right now');
    });

    it('when a rate limit was hit then no new request goes out until the wait is over', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      search.trending.mockRejectedValueOnce(apiError(429, 'TOO_MANY_REQUESTS', '20'));
      await render();

      buttonByText(fixture, 'Try again').click();
      await fixture.whenStable();
      expect(search.trending, 'still blocked').toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(21_000);
      buttonByText(fixture, 'Try again').click();
      await fixture.whenStable();

      expect(search.trending, 'allowed again').toHaveBeenCalledTimes(2);
      expect(images().length, 'results').toBe(3);
    });
  });
});
