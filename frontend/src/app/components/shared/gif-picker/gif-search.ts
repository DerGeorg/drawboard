import { HttpContext } from '@angular/common/http';
import { Service, inject, signal } from '@angular/core';
import { Gif, GifPage, GifsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { ApiError } from '../../../util/api-error';

/** At least this many characters before a search goes out (G7). */
export const MIN_QUERY_LENGTH = 2;
/** The longest search text of the contract. */
export const MAX_QUERY_LENGTH = 50;
/** The pause after the last key before a search goes out (G7: at least 400 ms). */
export const SEARCH_DEBOUNCE_MS = 450;
/** The last page the contract has (pages 0 to 9, 24 GIFs each). */
export const LAST_PAGE = 9;

/** Why a search failed, as far as the picker tells the user apart. */
export type GifProblem =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'rate'; readonly scope: 'user' | 'instance'; readonly waitSeconds?: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'other' };

/** `Retry-After` in whole seconds (the header carries seconds), or undefined. */
function retryAfter(error: ApiError): number | undefined {
  const seconds = Number(error.response.headers?.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

export function gifProblemOf(error: unknown): GifProblem {
  if (!(error instanceof ApiError)) {
    return { kind: 'other' };
  }
  if (error.status === 404 && error.code === 'GIFS_DISABLED') {
    return { kind: 'disabled' };
  }
  if (error.status === 429 && error.code === 'GIFS_BUDGET_EXHAUSTED') {
    return { kind: 'rate', scope: 'instance', waitSeconds: retryAfter(error) };
  }
  if (error.status === 429) {
    return { kind: 'rate', scope: 'user', waitSeconds: retryAfter(error) };
  }
  if (error.status === 503) {
    return { kind: 'unavailable' };
  }
  return { kind: 'other' };
}

/** "20 seconds", "3 minutes", or a general "a little while". */
export function waitText(seconds: number | undefined): string {
  if (seconds === undefined) {
    return 'a little while';
  }
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The message of the picker for a problem (G7, no toast: the picker says it itself). */
export function problemText(problem: GifProblem): string {
  switch (problem.kind) {
    case 'disabled':
      return 'GIF search is not available on this instance.';
    case 'rate':
      return problem.scope === 'instance'
        ? `The GIF search of this instance is used up for now. Try again in ${waitText(problem.waitSeconds)}.`
        : `You are searching too fast. Try again in ${waitText(problem.waitSeconds)}.`;
    case 'unavailable':
      return 'GIPHY cannot be reached right now. Try again later.';
    default:
      return 'The GIFs could not be loaded. Try again.';
  }
}

/**
 * GIF search through the backend (G4, G8): the search text goes in a POST body, never in a URL,
 * and the answers hold ids only. Every failure is handled by the picker, none by a toast (a
 * fast typist would get a flood of them).
 */
@Service()
export class GifSearch {
  private readonly api = inject(GifsService);
  private readonly quiet = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

  /** The backend said GIFS_DISABLED: there is no GIF search here, the picker button goes. */
  readonly disabled = signal(false);

  async search(q: string, page: number): Promise<GifPage> {
    return this.guard(
      firstValueFrom(
        this.api.searchGifs({ gifSearch: { q, page } }, 'body', false, { context: this.quiet }),
      ),
    );
  }

  async trending(): Promise<GifPage> {
    return this.guard(
      firstValueFrom(this.api.listTrendingGifs('body', false, { context: this.quiet })),
    );
  }

  /** Remembers GIFS_DISABLED (the instance has no key): the picker button goes away. */
  private async guard(page: Promise<GifPage>): Promise<GifPage> {
    try {
      return await page;
    } catch (error) {
      if (gifProblemOf(error).kind === 'disabled') {
        this.disabled.set(true);
      }
      throw error;
    }
  }
}

export type { Gif };
