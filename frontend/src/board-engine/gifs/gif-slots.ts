import { Emitter } from '@apps/drawboard-engine';

/** At most this many GIFs are loaded at the same time on one board (G9). */
export const MAX_LOADED_GIFS = 30;

/**
 * The room for loaded GIFs: a view takes a slot before it sets an image source and gives it back
 * when it removes the image (scrolled away, destroyed, failed). A view that finds no slot waits
 * and is told when one is free.
 */
export class GifSlots {
  readonly freed = new Emitter<void>();
  private used = 0;

  constructor(readonly max: number = MAX_LOADED_GIFS) {}

  get loaded(): number {
    return this.used;
  }

  /** A release function when there was room, else undefined. */
  acquire(): (() => void) | undefined {
    if (this.used >= this.max) {
      return undefined;
    }
    this.used++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.used--;
        this.freed.emit();
      }
    };
  }
}
