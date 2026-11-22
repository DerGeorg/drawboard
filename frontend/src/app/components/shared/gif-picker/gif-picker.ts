import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Gif } from '@apps/drawboard-api';

import { cleanGifAlt, gifUrl, isValidGiphyId } from '@apps/drawboard-engine';
import { GifConsentStore } from '../../../services/gif-consent';
import { WithSpan } from '../../../util/tracing';
import {
  GifProblem,
  GifSearch,
  LAST_PAGE,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
  gifProblemOf,
  problemText,
} from './gif-search';

/** The search text as the server sees it: trimmed, whitespace collapsed (G7). */
export function normalizeQuery(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Searches GIPHY through the backend and picks one GIF (architecture 3.14). The viewer's consent
 * comes first (G10): until they agreed to load images from GIPHY, the picker shows the notice
 * with the same two buttons as a GIF block and makes no request. Trending GIFs show when it
 * opens and whenever the search text is empty; a search goes out only after a pause of at least
 * 400 ms and with at least two characters (G7). Results are ids, previews are built by `gifUrl`
 * (constants and a validated id) and nothing else. "Powered by GIPHY" stays visible (G15).
 */
@Component({
  selector: 'drawboard-gif-picker',
  templateUrl: './gif-picker.html',
  host: { '(keydown.escape)': 'close($event)' },
})
export class GifPicker implements OnDestroy {
  private readonly search = inject(GifSearch);
  private readonly consent = inject(GifConsentStore);

  /** The board the "Load" consent is given for. */
  readonly boardKey = input.required<string>();
  readonly autofocus = input(true);
  /** A GIF was picked (its id has passed the rule). */
  readonly picked = output<Gif>();
  /** Escape was pressed, or the instance has no GIF search: the host closes the picker. */
  readonly closed = output();

  protected readonly maxLength = MAX_QUERY_LENGTH;
  protected readonly minLength = MIN_QUERY_LENGTH;
  protected readonly query = signal('');
  protected readonly items = signal<readonly Gif[]>([]);
  protected readonly page = signal(0);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(false);
  protected readonly problem = signal<GifProblem | undefined>(undefined);

  /** Did this viewer agree to load GIFs from GIPHY on this board? */
  protected readonly consented = computed(() => {
    this.consent.revision();
    return this.consent.allowed(this.boardKey());
  });
  protected readonly normalized = computed(() => normalizeQuery(this.query()));
  protected readonly tooShort = computed(
    () => this.normalized() !== '' && this.normalized().length < MIN_QUERY_LENGTH,
  );
  protected readonly searching = computed(() => this.normalized().length >= MIN_QUERY_LENGTH);
  protected readonly heading = computed(() => (this.searching() ? 'Results' : 'Trending'));
  protected readonly message = computed(() => {
    const problem = this.problem();
    return problem ? problemText(problem) : undefined;
  });

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requests = 0;
  /** No request before this time (a 429 said when to come back). */
  private blockedUntil = 0;
  private started = false;

  constructor() {
    afterNextRender(() => {
      if (this.autofocus()) {
        this.field()?.nativeElement.focus();
      }
    });
    // the first look: trending, as soon as the viewer has agreed (and not before)
    effect(() => {
      if (this.consented()) {
        untracked(() => this.start());
      }
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.requests++; // a late answer is ignored
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.consented()) {
      return;
    }
    const q = normalizeQuery(value);
    if (q === '') {
      void this.load('', 0);
    } else if (q.length >= MIN_QUERY_LENGTH) {
      // no request per key press: one after the pause
      this.timer = setTimeout(() => void this.load(q, 0), SEARCH_DEBOUNCE_MS);
    }
  }

  @WithSpan('GifPicker.loadBoard')
  protected loadBoard(): void {
    this.consent.allowBoard(this.boardKey());
    this.start();
  }

  @WithSpan('GifPicker.loadAlways')
  protected loadAlways(): void {
    this.consent.allowAlways();
    this.start();
  }

  protected go(step: number): void {
    const next = this.page() + step;
    if (next < 0 || next > LAST_PAGE || this.loading()) {
      return;
    }
    void this.load(this.searching() ? this.normalized() : '', next);
  }

  protected retry(): void {
    void this.load(this.searching() ? this.normalized() : '', this.page());
  }

  protected previewUrl(gif: Gif): string | undefined {
    return gifUrl(gif.id, 'small');
  }

  protected label(gif: Gif): string {
    return cleanGifAlt(gif.title) || 'GIF';
  }

  @WithSpan('GifPicker.pick')
  protected pick(gif: Gif): void {
    if (isValidGiphyId(gif.id)) {
      this.picked.emit(gif);
    }
  }

  protected close(event: Event): void {
    event.stopPropagation();
    this.closed.emit();
  }

  private start(): void {
    if (this.started || !this.consented()) {
      return;
    }
    this.started = true;
    const q = this.normalized();
    void this.load(q.length >= MIN_QUERY_LENGTH ? q : '', 0);
  }

  private async load(q: string, page: number): Promise<void> {
    if (Date.now() < this.blockedUntil) {
      return;
    }
    const request = ++this.requests;
    this.loading.set(true);
    this.problem.set(undefined);
    try {
      const result = q === '' ? await this.search.trending() : await this.search.search(q, page);
      if (request !== this.requests) {
        return; // a newer search is on its way
      }
      this.items.set(result.items.filter((g) => isValidGiphyId(g.id)));
      this.page.set(q === '' ? 0 : page);
      this.hasMore.set(q !== '' && result.hasMore && page < LAST_PAGE);
    } catch (error) {
      if (request !== this.requests) {
        return;
      }
      const problem = gifProblemOf(error);
      this.problem.set(problem);
      this.items.set([]);
      if (problem.kind === 'rate') {
        this.blockedUntil = Date.now() + (problem.waitSeconds ?? 30) * 1000;
      }
      if (problem.kind === 'disabled') {
        this.closed.emit();
      }
    } finally {
      if (request === this.requests) {
        this.loading.set(false);
      }
    }
  }
}
