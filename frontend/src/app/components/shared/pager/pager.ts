import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PageInfo } from '@apps/drawboard-api';

/**
 * Previous / next links for a paged list. The page lives in the URL (?page=N, 1-based) so it
 * survives reloads and can be linked; the routed page reads it through an input.
 */
@Component({
  selector: 'drawboard-pager',
  imports: [RouterLink],
  templateUrl: './pager.html',
  // block: the page sets a top margin on <drawboard-pager>, and an inline host ignores vertical margins
  host: { class: 'block' },
})
export class Pager {
  /** Page info from the API (zero-based `number`). */
  readonly page = input.required<PageInfo>();

  /** 1-based number as shown to the user and used in ?page=. */
  protected readonly current = computed(() => this.page().number + 1);
  protected readonly hasPrevious = computed(() => this.page().number > 0);
  protected readonly hasNext = computed(() => this.page().number + 1 < this.page().totalPages);
}
