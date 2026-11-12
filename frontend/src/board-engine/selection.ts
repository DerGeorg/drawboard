import { Emitter } from './util/emitter';

/** The ids (blocks, connectors, strokes) the user selected. Insertion ordered. */
export class SelectionState {
  private ids = new Set<string>();
  readonly changed = new Emitter<ReadonlySet<string>>();

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  list(): string[] {
    return Array.from(this.ids);
  }

  set(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.ids.size && [...next].every((id) => this.ids.has(id))) {
      return;
    }
    this.ids = next;
    this.changed.emit(this.ids);
  }

  add(id: string): void {
    if (!this.ids.has(id)) {
      this.ids = new Set(this.ids).add(id);
      this.changed.emit(this.ids);
    }
  }

  toggle(id: string): void {
    const next = new Set(this.ids);
    if (!next.delete(id)) {
      next.add(id);
    }
    this.set(next);
  }

  clear(): void {
    this.set([]);
  }

  /** Drops ids for which `exists` is false (deleted by anyone). */
  prune(exists: (id: string) => boolean): void {
    this.set(this.list().filter(exists));
  }
}
