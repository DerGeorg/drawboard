import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  resource,
  signal,
  viewChild,
} from '@angular/core';

import { WithSpan } from '../../../util/tracing';
import { Emoji, EmojiCatalog, EmojiGroupKey, searchEmojis } from './emoji-catalog';
import { loadRecent, rememberRecent } from './emoji-recent';

type TabKey = EmojiGroupKey | 'recent';

interface Tab {
  readonly key: TabKey;
  readonly label: string;
  /** An emoji of the group stands for it on the tab. */
  readonly icon: string;
}

const TABS: readonly Tab[] = [
  { key: 'recent', label: 'Recently used', icon: '🕘' },
  { key: 'smileys', label: 'Smileys & emotion', icon: '😀' },
  { key: 'people', label: 'People & body', icon: '👋' },
  { key: 'animals', label: 'Animals & nature', icon: '🐻' },
  { key: 'food', label: 'Food & drink', icon: '🍔' },
  { key: 'travel', label: 'Travel & places', icon: '✈️' },
  { key: 'activities', label: 'Activities', icon: '⚽' },
  { key: 'objects', label: 'Objects', icon: '💡' },
  { key: 'symbols', label: 'Symbols', icon: '❤️' },
  { key: 'flags', label: 'Flags', icon: '🏁' },
];

/** Columns of the grid (the arrow keys move by this many for up and down). */
const COLUMNS = 8;

let nextId = 0;

/**
 * Picks one emoji: group tabs, a search over names and tags, and the ones used last. The data is
 * a lazy chunk, loaded when the first picker is created. Keyboard: Down from the search field
 * enters the grid, arrows move in it (Home and End jump), Enter or Space picks, Escape closes.
 */
@Component({
  selector: 'drawboard-emoji-picker',
  templateUrl: './emoji-picker.html',
  host: { '(keydown.escape)': 'close($event)' },
})
export class EmojiPicker {
  private readonly catalog = inject(EmojiCatalog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Puts the focus in the search field once it is shown. */
  readonly autofocus = input(true);
  /** An emoji was picked. */
  readonly picked = output<string>();
  /** Escape was pressed: the host closes the picker. */
  readonly closed = output();

  protected readonly tabs = TABS;
  protected readonly columns = COLUMNS;
  protected readonly id = `emoji-picker-${nextId++}`;
  protected readonly emojis = resource({ loader: () => this.catalog.load() });
  protected readonly query = signal('');
  protected readonly recent = signal<readonly string[]>(loadRecent());
  protected readonly tab = signal<TabKey>(this.recent().length > 0 ? 'recent' : 'smileys');
  protected readonly active = signal(0);

  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly grid = viewChild<ElementRef<HTMLElement>>('grid');

  private readonly byGroup = computed(() => {
    const groups = new Map<TabKey, Emoji[]>();
    for (const emoji of this.emojis.value() ?? []) {
      const list = groups.get(emoji.group) ?? [];
      list.push(emoji);
      groups.set(emoji.group, list);
    }
    return groups;
  });

  protected readonly searching = computed(() => this.query().trim() !== '');

  /** What the grid shows: search results, the recent ones, or one group. */
  protected readonly visible = computed<readonly Emoji[]>(() => {
    const all = this.emojis.value() ?? [];
    if (this.searching()) {
      return searchEmojis(all, this.query());
    }
    if (this.tab() === 'recent') {
      const byChar = new Map(all.map((e) => [e.char, e]));
      return this.recent().map(
        (char) => byChar.get(char) ?? { char, name: char, group: 'symbols', haystack: '' },
      );
    }
    return this.byGroup().get(this.tab()) ?? [];
  });

  protected readonly heading = computed(() =>
    this.searching() ? 'Search results' : (TABS.find((t) => t.key === this.tab())?.label ?? ''),
  );

  constructor() {
    afterNextRender(() => {
      if (this.autofocus()) {
        this.search()?.nativeElement.focus();
      }
    });
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  @WithSpan('EmojiPicker.selectTab', { attributes: (key: TabKey) => ({ 'emoji.group': key }) })
  protected selectTab(key: TabKey): void {
    this.tab.set(key);
    this.query.set('');
    this.active.set(0);
  }

  @WithSpan('EmojiPicker.pick')
  protected pick(emoji: Emoji): void {
    this.recent.set(rememberRecent(emoji.char, this.recent()));
    this.picked.emit(emoji.char);
  }

  protected close(event: Event): void {
    event.stopPropagation();
    this.closed.emit();
  }

  /** The search field: Down enters the grid. */
  protected searchKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' && this.visible().length > 0) {
      event.preventDefault();
      this.focusCell(this.active());
    }
  }

  /** Arrows, Home and End inside the grid (roving tabindex). */
  protected gridKey(event: KeyboardEvent): void {
    const last = this.visible().length - 1;
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -COLUMNS,
      ArrowDown: COLUMNS,
    };
    let next: number | undefined;
    if (event.key in step) {
      next = this.active() + (step[event.key] as number);
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    }
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    if (next < 0 && event.key === 'ArrowUp') {
      this.search()?.nativeElement.focus();
      return;
    }
    this.focusCell(Math.min(Math.max(next, 0), last));
  }

  /** Left and Right move between the tabs. */
  protected tabKey(event: KeyboardEvent, index: number): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = TABS[(index + step + TABS.length) % TABS.length] as Tab;
    this.selectTab(next.key);
    queueMicrotask(() =>
      this.host.nativeElement.querySelector<HTMLElement>(`[data-tab="${next.key}"]`)?.focus(),
    );
  }

  private focusCell(index: number): void {
    this.active.set(index);
    // the roving tabindex moves with the next render; focus the cell right away
    this.grid()?.nativeElement.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  }
}
