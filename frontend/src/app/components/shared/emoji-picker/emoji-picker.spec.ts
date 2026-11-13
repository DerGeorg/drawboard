import { ComponentFixture, TestBed } from '@angular/core/testing';

import { all, textOf } from '../../../test/dom';
import { EmojiCatalog, RawEmoji } from './emoji-catalog';
import { EmojiPicker } from './emoji-picker';

const RAW: RawEmoji[] = [
  { unicode: '😀', label: 'grinning face', group: 0, tags: ['happy', 'smile'] },
  { unicode: '🙂', label: 'slightly smiling face', group: 0, tags: ['happy'] },
  { unicode: '👋', label: 'waving hand', group: 1, tags: ['hello', 'bye'] },
  { unicode: '🐻', label: 'bear', group: 3, tags: ['animal'] },
  { unicode: '🇦🇹', label: 'flag: Austria', group: 9, tags: ['at'] },
];
const COLUMNS = 8;
const MANY: RawEmoji[] = Array.from({ length: 20 }, (_, i) => ({
  unicode: String.fromCodePoint(0x1f600 + i),
  label: `face ${i}`,
  group: 0,
}));

describe('EmojiPicker', () => {
  let fixture: ComponentFixture<EmojiPicker>;
  let picked: string[];
  let closed: number;
  let loadRaw: ReturnType<typeof vi.fn<() => Promise<RawEmoji[]>>>;

  async function render(raw: RawEmoji[] = RAW): Promise<void> {
    loadRaw = vi.fn<() => Promise<RawEmoji[]>>().mockResolvedValue(raw);
    TestBed.inject(EmojiCatalog).loadRaw = loadRaw;
    fixture = TestBed.createComponent(EmojiPicker);
    picked = [];
    closed = 0;
    fixture.componentInstance.picked.subscribe((e) => picked.push(e));
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
  }

  const cells = (): HTMLButtonElement[] => all<HTMLButtonElement>(fixture, '[data-index]');
  const chars = (): string[] => cells().map((c) => c.textContent?.trim() ?? '');
  const tab = (key: string): HTMLButtonElement =>
    all<HTMLButtonElement>(fixture, `[data-tab="${key}"]`)[0] as HTMLButtonElement;
  const searchBox = (): HTMLInputElement =>
    all<HTMLInputElement>(fixture, 'input[type=search]')[0] as HTMLInputElement;
  const key = (el: HTMLElement, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };
  async function search(value: string): Promise<void> {
    const box = searchBox();
    box.value = value;
    box.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  describe('loading', () => {
    it('when created then a loading hint shows until the data is there', async () => {
      TestBed.inject(EmojiCatalog).loadRaw = () => new Promise(() => undefined);
      fixture = TestBed.createComponent(EmojiPicker);
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve));

      expect(textOf(fixture), 'while loading').toContain('Loading emojis');
      expect(cells(), 'cells').toHaveLength(0);
    });

    it('when created then the data is loaded once and the first group is shown', async () => {
      await render();

      expect(loadRaw, 'loads').toHaveBeenCalledTimes(1);
      expect(chars(), 'smileys').toEqual(['😀', '🙂']);
      expect(tab('smileys').getAttribute('aria-selected'), 'selected tab').toBe('true');
    });

    it('when loading fails then a message with a retry is shown, and retry loads again', async () => {
      loadRaw = vi.fn<() => Promise<RawEmoji[]>>().mockRejectedValueOnce(new Error('offline'));
      loadRaw.mockResolvedValue(RAW);
      TestBed.inject(EmojiCatalog).loadRaw = loadRaw;
      fixture = TestBed.createComponent(EmojiPicker);
      await fixture.whenStable();
      expect(textOf(fixture), 'error').toContain('could not be loaded');

      all<HTMLButtonElement>(fixture, 'button')
        .find((b) => b.textContent?.includes('Try again'))
        ?.click();
      await fixture.whenStable();

      expect(chars(), 'after retry').toEqual(['😀', '🙂']);
    });

    it('when created then the search field has the focus', async () => {
      TestBed.inject(EmojiCatalog).loadRaw = async () => RAW;
      fixture = TestBed.createComponent(EmojiPicker);
      document.body.appendChild(fixture.nativeElement);

      await fixture.whenStable();

      expect(document.activeElement, 'focus').toBe(searchBox());
      fixture.nativeElement.remove();
    });
  });

  describe('groups', () => {
    it('when a tab is clicked then its emojis show', async () => {
      await render();

      tab('animals').click();
      await fixture.whenStable();

      expect(chars(), 'animals').toEqual(['🐻']);
      expect(tab('animals').getAttribute('aria-selected'), 'selected').toBe('true');
      expect(tab('smileys').getAttribute('aria-selected'), 'previous').toBe('false');
    });

    it('when a group has no emoji then the grid says so', async () => {
      await render();

      tab('objects').click();
      await fixture.whenStable();

      expect(chars(), 'cells').toEqual([]);
      expect(textOf(fixture), 'message').toContain('Nothing here yet');
    });

    it('when Right is pressed on a tab then the next tab is selected and focused', async () => {
      await render();
      document.body.appendChild(fixture.nativeElement);

      key(tab('smileys'), 'ArrowRight');
      await fixture.whenStable();
      await Promise.resolve();

      expect(tab('people').getAttribute('aria-selected'), 'selected').toBe('true');
      expect(document.activeElement, 'focus').toBe(tab('people'));
      fixture.nativeElement.remove();
    });
  });

  describe('search', () => {
    it('when a name is typed then matching emojis show, whatever the tab', async () => {
      await render();

      await search('bear');

      expect(chars(), 'results').toEqual(['🐻']);
      expect(tab('smileys').getAttribute('aria-selected'), 'no tab while searching').toBe('false');
    });

    it('when a tag is typed then matching emojis show', async () => {
      await render();

      await search('hello');

      expect(chars(), 'results').toEqual(['👋']);
    });

    it('when nothing matches then the grid says so', async () => {
      await render();

      await search('xyzzy');

      expect(chars(), 'cells').toEqual([]);
      expect(textOf(fixture), 'message').toContain('No emoji found');
    });

    it('when the search is cleared then the tab shows again', async () => {
      await render();
      await search('bear');

      await search('');

      expect(chars(), 'smileys').toEqual(['😀', '🙂']);
    });

    it('when a tab is clicked while searching then the search ends', async () => {
      await render();
      await search('bear');

      tab('people').click();
      await fixture.whenStable();

      expect(searchBox().value, 'search field').toBe('');
      expect(chars(), 'people').toEqual(['👋']);
    });
  });

  describe('picking', () => {
    it('when an emoji is clicked then picked fires with it', async () => {
      await render();

      cells()[1]?.click();

      expect(picked, 'picked').toEqual(['🙂']);
    });

    it('when an emoji is picked then it is the first of the recently used, and shown in a new picker', async () => {
      await render();
      cells()[0]?.click();
      tab('animals').click();
      await fixture.whenStable();
      cells()[0]?.click();
      fixture.destroy();

      await render();

      expect(tab('recent').getAttribute('aria-selected'), 'starts on recent').toBe('true');
      expect(chars(), 'recent').toEqual(['🐻', '😀']);
    });

    it('when nothing was picked yet then the recent tab is empty and the picker starts on smileys', async () => {
      await render();

      tab('recent').click();
      await fixture.whenStable();

      expect(chars(), 'cells').toEqual([]);
      expect(textOf(fixture), 'message').toContain('Emojis you pick show up here');
    });

    it('when localStorage is not available then the picker still works and picks', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      await render();

      cells()[0]?.click();
      tab('recent').click();
      await fixture.whenStable();

      expect(picked, 'picked').toEqual(['😀']);
      expect(chars(), 'recent of this visit').toEqual(['😀']);
    });
  });

  describe('keyboard and accessibility', () => {
    it('when the emojis are shown then each button is named and only one is a tab stop', async () => {
      await render();

      expect(
        cells().map((c) => c.getAttribute('aria-label')),
        'names',
      ).toEqual(['grinning face', 'slightly smiling face']);
      expect(
        cells().map((c) => c.tabIndex),
        'tab stops',
      ).toEqual([0, -1]);
      expect(all(fixture, '[role=tablist] [role=tab]'), 'tabs').toHaveLength(10);
      expect(searchBox().getAttribute('aria-label'), 'search label').toBe('Search emojis');
    });

    it('when Down is pressed in the search field then the first emoji gets the focus', async () => {
      await render();
      document.body.appendChild(fixture.nativeElement);

      key(searchBox(), 'ArrowDown');

      expect(document.activeElement, 'focus').toBe(cells()[0]);
      fixture.nativeElement.remove();
    });

    it('when arrows, Home and End are pressed in the grid then the focus moves by cells and rows', async () => {
      await render(MANY);
      document.body.appendChild(fixture.nativeElement);
      cells()[0]?.focus();

      key(cells()[0] as HTMLElement, 'ArrowRight');
      expect(document.activeElement, 'right').toBe(cells()[1]);

      key(cells()[1] as HTMLElement, 'ArrowDown');
      expect(document.activeElement, 'down one row').toBe(cells()[1 + COLUMNS]);

      key(cells()[1 + COLUMNS] as HTMLElement, 'ArrowUp');
      expect(document.activeElement, 'up one row').toBe(cells()[1]);

      key(cells()[1] as HTMLElement, 'ArrowLeft');
      key(cells()[0] as HTMLElement, 'ArrowLeft');
      expect(document.activeElement, 'left at the start stays').toBe(cells()[0]);

      key(cells()[0] as HTMLElement, 'End');
      expect(document.activeElement, 'end').toBe(cells()[19]);

      key(cells()[19] as HTMLElement, 'ArrowDown');
      expect(document.activeElement, 'down past the end stays at the last').toBe(cells()[19]);

      key(cells()[19] as HTMLElement, 'Home');
      expect(document.activeElement, 'home').toBe(cells()[0]);
      fixture.nativeElement.remove();
    });

    it('when Up is pressed in the first row then the search field gets the focus', async () => {
      await render();
      document.body.appendChild(fixture.nativeElement);
      cells()[0]?.focus();

      key(cells()[0] as HTMLElement, 'ArrowUp');

      expect(document.activeElement, 'focus').toBe(searchBox());
      fixture.nativeElement.remove();
    });

    it('when Escape is pressed then closed fires and the key goes no further', async () => {
      await render();
      const outer = vi.fn();
      document.addEventListener('keydown', outer);

      key(searchBox(), 'Escape');

      expect(closed, 'closed').toBe(1);
      expect(outer, 'bubbled').not.toHaveBeenCalled();
      document.removeEventListener('keydown', outer);
    });
  });
});
