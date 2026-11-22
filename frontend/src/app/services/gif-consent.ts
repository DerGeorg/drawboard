import { DestroyRef, Service, inject, signal } from '@angular/core';

import { GIF_CONSENT_KEY, GifConsent } from '../../board-engine/gifs/gif-consent';

/**
 * The viewer's GIF consent for the whole app (G10): "Load" per board for this session, "Always
 * in this browser" in localStorage. The engine's blocks, the picker and the "Forget GIF consent"
 * menu entry all ask this one object. The signals let templates follow changes.
 */
@Service()
export class GifConsentStore extends GifConsent {
  /** Counts every grant and revocation: read it inside `computed` to depend on the consent. */
  readonly revision = signal(0);
  /** "Always in this browser" is on (the menu entry "Forget GIF consent" shows then). */
  readonly remembered = signal(false);

  constructor() {
    super();
    // another tab chose "Forget GIF consent" (or "Always"): every block here follows at once
    const onStorage = (event: StorageEvent): void => {
      if (event.key === GIF_CONSENT_KEY || event.key === null) {
        this.changed.emit();
      }
    };
    window.addEventListener('storage', onStorage);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', onStorage));
    this.remembered.set(this.always());
    this.changed.on(() => {
      this.remembered.set(this.always());
      this.revision.update((n) => n + 1);
    });
  }
}
