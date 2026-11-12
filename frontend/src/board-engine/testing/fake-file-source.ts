import { FileLinks, FileMeta, FileSource, FileState } from '../files/file-source';

export const FILE_ID = '0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f';

export function aFileMeta(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: FILE_ID,
    name: 'photo.png',
    mediaType: 'image/png',
    kind: 'IMAGE',
    size: 2048,
    conversion: 'NONE',
    width: 800,
    height: 600,
    ...overrides,
  };
}

export function someLinks(n = 1, overrides: Partial<FileLinks> = {}): FileLinks {
  return {
    url: `/files/${FILE_ID}?v=original&exp=${n}&sig=s${n}`,
    originalUrl: `/files/${FILE_ID}?v=original&exp=${n}&sig=s${n}`,
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

/** A FileSource the test drives: `emit` pushes a state to the watchers of one file. */
export class FakeFileSource implements FileSource {
  readonly watchers = new Map<string, Set<(state: FileState) => void>>();
  readonly downloads: string[] = [];
  readonly refreshes: string[] = [];
  private readonly states = new Map<string, FileState>();

  watch(fileId: string, listener: (state: FileState) => void): () => void {
    const set = this.watchers.get(fileId) ?? new Set();
    set.add(listener);
    this.watchers.set(fileId, set);
    const known = this.states.get(fileId);
    if (known) {
      listener(known);
    }
    return () => set.delete(listener);
  }

  download(fileId: string): void {
    this.downloads.push(fileId);
  }

  refresh(fileId: string): void {
    this.refreshes.push(fileId);
  }

  emit(fileId: string, state: FileState): void {
    this.states.set(fileId, state);
    for (const l of this.watchers.get(fileId) ?? []) {
      l(state);
    }
  }

  watching(fileId: string): number {
    return this.watchers.get(fileId)?.size ?? 0;
  }
}
