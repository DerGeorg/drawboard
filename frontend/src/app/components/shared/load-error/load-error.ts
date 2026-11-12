import { Component, computed, inject, input, output } from '@angular/core';

import { ErrorMessages } from '../../../services/error-messages';
import { ApiError } from '../../../util/api-error';

/** Inline alert for a resource that could not be loaded, with the request id and a retry. */
@Component({
  selector: 'drawboard-load-error',
  templateUrl: './load-error.html',
  // block: pages set a top margin on <drawboard-load-error>, and an inline host ignores vertical margins
  host: { class: 'block' },
})
export class LoadError {
  private readonly messages = inject(ErrorMessages);

  /** The resource's error() - an ApiError after errorInterceptor. */
  readonly error = input.required<unknown>();
  /** What failed to load, e.g. "your boards". */
  readonly subject = input.required<string>();
  readonly retry = output();

  protected readonly apiError = computed(() => {
    const error = this.error();
    return error instanceof ApiError ? error : undefined;
  });
  protected readonly reason = computed(() => {
    const apiError = this.apiError();
    return apiError ? this.messages.text(apiError.problem) : 'Unexpected error.';
  });
}
