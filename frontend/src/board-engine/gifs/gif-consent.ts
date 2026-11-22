import { Emitter } from '@apps/drawboard-engine';

/** The one localStorage key of the GIF consent (G10). */
export const GIF_CONSENT_KEY = 'drawboard.gifs.consent';
/** The only value that counts as "always": anything else in the storage is ignored. */
export const GIF_CONSENT_ALWAYS = 'always';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser's storage, or undefined where it throws (private window, blocked site data). */
function browserStorage(): Store | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Whether this viewer agreed that GIFs are loaded from GIPHY by their browser (G10): loading
 * sends their IP address and user agent to GIPHY. Per viewer, guests included, never decided by
 * the instance. Two grades: "Load" (this board, until the tab is closed - memory only) and
 * "Always in this browser" (one localStorage key, read with validation and try/catch on every
 * question, so a revocation in another tab counts at once - the app's store also listens to the
 * `storage` event to tell the views; without usable storage the choice holds in memory).
 */
export class GifConsent {
  /** Fires when a grant or a revocation changed the answer (views and menus re-read it). */
  readonly changed = new Emitter<void>();
  private readonly boards = new Set<string>();
  private memoryAlways = false;

  constructor(private readonly storage: Store | undefined = browserStorage()) {}

  /** The viewer chose "Always in this browser". */
  always(): boolean {
    try {
      if (this.storage?.getItem(GIF_CONSENT_KEY) === GIF_CONSENT_ALWAYS) {
        return true;
      }
    } catch {
      // a storage that throws counts as empty
    }
    return this.memoryAlways;
  }

  /** Is any consent given (on any board or always)? Decides whether "Forget" has an effect. */
  granted(): boolean {
    return this.always() || this.boards.size > 0;
  }

  /** May GIFs load on this board now? */
  allowed(boardKey: string): boolean {
    return this.always() || this.boards.has(boardKey);
  }

  /** "Load": this board, this session. */
  allowBoard(boardKey: string): void {
    this.boards.add(boardKey);
    this.changed.emit();
  }

  /** "Always in this browser". Without usable storage it holds until the page is closed. */
  allowAlways(): void {
    // memory only as the fallback: a choice that IS stored must be revocable from other tabs
    this.memoryAlways = true;
    try {
      if (this.storage) {
        this.storage.setItem(GIF_CONSENT_KEY, GIF_CONSENT_ALWAYS);
        this.memoryAlways = false;
      }
    } catch {
      // not storable: the choice holds in memory
    }
    this.changed.emit();
  }

  /** "Forget GIF consent": both grades go, GIFs show their placeholder again. */
  forget(): void {
    this.boards.clear();
    this.memoryAlways = false;
    try {
      this.storage?.removeItem(GIF_CONSENT_KEY);
    } catch {
      // nothing stored that could be removed
    }
    this.changed.emit();
  }
}
