import { Component, inject } from '@angular/core';

import { Toast, Toasts } from '../../../services/toasts';

/** Renders the toasts of the Toasts service (bottom right, newest last). */
@Component({
  selector: 'drawboard-toast-outlet',
  templateUrl: './toast-outlet.html',
})
export class ToastOutlet {
  protected readonly toasts = inject(Toasts);

  /** Complete class strings per kind - Tailwind only generates what it finds written out. */
  protected readonly cardClass = {
    error:
      'flex items-start gap-3 rounded-xl border-l-(length:--border-size-xl) border-l-(--color-st-red) bg-(--color-st-surface) p-4 text-(--color-st-black) shadow-lg',
    success:
      'flex items-start gap-3 rounded-xl border-l-(length:--border-size-xl) border-l-(--color-st-green-def) bg-(--color-st-surface) p-4 text-(--color-st-black) shadow-lg',
  } as const satisfies Record<Toast['kind'], string>;
}
