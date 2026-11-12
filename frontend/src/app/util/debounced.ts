import { Signal, effect, signal, untracked } from '@angular/core';

/**
 * A signal that follows `source` after it stayed unchanged for `ms` milliseconds - for search
 * fields that must not fire a request per keystroke. Call it in an injection context.
 */
export function debounced<T>(source: () => T, ms: number): Signal<T> {
  const out = signal(untracked(source));
  effect((onCleanup) => {
    const value = source();
    const timer = setTimeout(() => out.set(value), ms);
    onCleanup(() => clearTimeout(timer));
  });
  return out.asReadonly();
}
