import { HttpContext } from '@angular/common/http';
import { DestroyRef, Service, inject } from '@angular/core';
import { BoardFile, FileUrl, FilesService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import type { FileLinks, FileMeta, FileSource, FileState } from '@apps/drawboard-engine';
import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { RUNTIME_CONFIG } from '../../../services/runtime-config';

/** URLs are renewed this long before they expire (they live at most an hour, S4.4). */
export const RENEW_BEFORE_MS = 5 * 60_000;
/** A failed load is tried again after this long. */
export const RETRY_MS = 10_000;
/** Polling of a converting document: starts at 2 s, grows by half, at most 30 s. */
export const POLL_FIRST_MS = 2_000;
export const POLL_MAX_MS = 30_000;
/** getFileUrls takes at most 100 ids. */
const URL_BATCH = 100;

/** The only form of URL the API hands out (`FileUrl`): a path below /files/ with a query. */
const FILE_PATH = /^\/files\/[0-9a-f-]{36}\?[A-Za-z0-9=&_%.-]+$/;

interface Entry {
  readonly listeners: Set<(state: FileState) => void>;
  meta?: FileMeta;
  links?: FileLinks;
  state: FileState;
  missing?: boolean;
  pollTimer?: ReturnType<typeof setTimeout>;
  pollDelay?: number;
}

/**
 * The files of ONE open board for the engine's file blocks (FileSource; provided by BoardPage):
 * metadata from listFiles/getFile, signed URLs from getFileUrls - batched, kept in memory only,
 * renewed before they expire and never logged, put into the document, telemetry or storage
 * (S4.4, S7.2). Documents that are still converting are polled with backoff (there is no push
 * in M3). Background calls handle their errors here (no toast per block): a block shows
 * "retrying" and the call is repeated.
 */
@Service({ autoProvided: false })
export class BoardFiles implements FileSource {
  private readonly api = inject(FilesService);
  private readonly filesOrigin = inject(RUNTIME_CONFIG).filesOrigin;
  private readonly entries = new Map<string, Entry>();
  private readonly context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

  private boardId: string | undefined;
  private listed: Promise<void> | undefined;
  private pendingUrls = new Set<string>();
  private urlsScheduled = false;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  /** The board whose files are served; set once by the board page. */
  open(boardId: string): void {
    this.boardId = boardId;
  }

  /** A file this client just uploaded: no need to load its metadata again. */
  remember(file: BoardFile): void {
    const meta = toMeta(file);
    const entry = this.entry(meta.id);
    entry.meta = meta;
    entry.missing = false;
  }

  watch(fileId: string, listener: (state: FileState) => void): () => void {
    const entry = this.entry(fileId);
    entry.listeners.add(listener);
    listener(entry.state);
    if (entry.listeners.size === 1) {
      void this.load(fileId);
    }
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        this.stopPolling(entry);
      }
    };
  }

  refresh(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (entry?.meta && !entry.missing) {
      entry.links = undefined;
      this.requestUrls(fileId);
    }
  }

  /** Downloads the original under its name, with URLs that are still valid for a while. */
  async download(fileId: string): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry?.meta || entry.missing) {
      return;
    }
    if (!entry.links || entry.links.expiresAt - Date.now() < 30_000) {
      await this.fetchUrls([fileId]);
    }
    const links = entry.links;
    if (!links) {
      return;
    }
    const a = document.createElement('a');
    a.href = links.originalUrl;
    a.download = entry.meta.name;
    a.rel = 'noopener noreferrer';
    a.referrerPolicy = 'no-referrer';
    if (this.filesOrigin) {
      a.target = '_blank'; // `download` is ignored across origins: the attachment header decides
    }
    a.click();
  }

  private entry(fileId: string): Entry {
    let entry = this.entries.get(fileId);
    if (!entry) {
      entry = { listeners: new Set(), state: { status: 'loading' } };
      this.entries.set(fileId, entry);
    }
    return entry;
  }

  private async load(fileId: string): Promise<void> {
    const entry = this.entry(fileId);
    if (!entry.meta && !entry.missing) {
      try {
        await this.listOnce();
        if (!entry.meta && !entry.missing) {
          await this.loadOne(fileId);
        }
      } catch {
        this.fail(fileId);
        return;
      }
    }
    if (entry.missing) {
      this.publish(fileId, { status: 'missing' });
      return;
    }
    if (entry.links && entry.links.expiresAt - Date.now() > RENEW_BEFORE_MS) {
      this.publishReady(fileId);
    } else {
      this.requestUrls(fileId);
    }
    this.pollIfConverting(fileId);
  }

  /** All metadata of the board in one call, once; files uploaded later come from getFile. */
  private listOnce(): Promise<void> {
    if (!this.listed) {
      const boardId = this.requireBoard();
      this.listed = firstValueFrom(
        this.api.listFiles({ boardId }, 'body', false, { context: this.context }),
      ).then(
        (list) => {
          for (const file of list.items) {
            this.remember(file);
          }
        },
        (error: unknown) => {
          this.listed = undefined; // try again with the next watch or retry
          throw error;
        },
      );
    }
    return this.listed;
  }

  private async loadOne(fileId: string): Promise<void> {
    const entry = this.entry(fileId);
    try {
      const file = await firstValueFrom(
        this.api.getFile({ boardId: this.requireBoard(), fileId }, 'body', false, {
          context: this.context,
        }),
      );
      entry.meta = toMeta(file);
      entry.missing = false;
    } catch (error) {
      if (status(error) === 404 || status(error) === 400) {
        entry.missing = true;
        return;
      }
      throw error;
    }
  }

  private requestUrls(fileId: string): void {
    this.pendingUrls.add(fileId);
    if (!this.urlsScheduled) {
      this.urlsScheduled = true;
      // every block mounted in the same task shares one request
      queueMicrotask(() => {
        this.urlsScheduled = false;
        const ids = [...this.pendingUrls];
        this.pendingUrls = new Set();
        void this.fetchUrls(ids);
      });
    }
  }

  private async fetchUrls(ids: string[]): Promise<void> {
    const boardId = this.requireBoard();
    for (let i = 0; i < ids.length; i += URL_BATCH) {
      const batch = ids.slice(i, i + URL_BATCH);
      let answer: FileUrl[];
      try {
        const list = await firstValueFrom(
          this.api.getFileUrls({ boardId, ids: batch.join(',') }, 'body', false, {
            context: this.context,
          }),
        );
        answer = list.items;
      } catch {
        batch.forEach((id) => this.fail(id));
        continue;
      }
      if (this.destroyed) {
        return;
      }
      const byId = new Map(answer.map((u) => [u.fileId.toLowerCase(), u]));
      for (const id of batch) {
        const entry = this.entry(id);
        const links = byId.get(id) && this.toLinks(byId.get(id) as FileUrl);
        if (!links) {
          // left out of the answer: not (or no longer) a file of this board
          entry.missing = true;
          entry.links = undefined;
          this.publish(id, { status: 'missing' });
        } else {
          entry.links = links;
          this.publishReady(id);
        }
      }
    }
    this.scheduleRenewal();
  }

  /** One timer for the URL set that expires first; renews every watched file in that window. */
  private scheduleRenewal(): void {
    clearTimeout(this.renewTimer);
    let first = Infinity;
    for (const entry of this.entries.values()) {
      if (entry.listeners.size > 0 && entry.links) {
        first = Math.min(first, entry.links.expiresAt);
      }
    }
    if (first === Infinity || this.destroyed) {
      return;
    }
    const delay = Math.max(1_000, first - RENEW_BEFORE_MS - Date.now());
    this.renewTimer = setTimeout(() => {
      const due = [...this.entries.entries()]
        .filter(
          ([, e]) =>
            e.listeners.size > 0 && e.links && e.links.expiresAt - Date.now() <= RENEW_BEFORE_MS,
        )
        .map(([id]) => id);
      // links of files nobody shows any more are dropped instead of renewed
      for (const e of this.entries.values()) {
        if (e.listeners.size === 0) {
          e.links = undefined;
        }
      }
      if (due.length > 0) {
        void this.fetchUrls(due);
      } else {
        this.scheduleRenewal();
      }
    }, delay);
  }

  private pollIfConverting(fileId: string): void {
    const entry = this.entry(fileId);
    if (entry.meta?.conversion !== 'PENDING' || entry.pollTimer || entry.listeners.size === 0) {
      return;
    }
    const delay = entry.pollDelay ?? POLL_FIRST_MS;
    entry.pollTimer = setTimeout(async () => {
      entry.pollTimer = undefined;
      entry.pollDelay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
      try {
        await this.loadOne(fileId);
      } catch {
        // keep polling: the server or the network may be back next time
      }
      if (this.destroyed || entry.listeners.size === 0) {
        return;
      }
      if (entry.missing) {
        this.publish(fileId, { status: 'missing' });
      } else if (entry.meta?.conversion === 'PENDING') {
        this.pollIfConverting(fileId);
      } else {
        entry.pollDelay = undefined;
        this.refresh(fileId); // DONE brings the pdf variant, FAILED stays with the original
      }
    }, delay);
  }

  private stopPolling(entry: Entry): void {
    clearTimeout(entry.pollTimer);
    entry.pollTimer = undefined;
  }

  private fail(fileId: string): void {
    this.publish(fileId, { status: 'error' });
    if (!this.retryTimer && !this.destroyed) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        for (const [id, e] of this.entries) {
          if (e.listeners.size > 0 && e.state.status === 'error') {
            void this.load(id);
          }
        }
      }, RETRY_MS);
    }
  }

  private publishReady(fileId: string): void {
    const entry = this.entry(fileId);
    if (entry.meta && entry.links) {
      this.publish(fileId, { status: 'ready', file: entry.meta, links: entry.links });
    }
  }

  private publish(fileId: string, state: FileState): void {
    const entry = this.entry(fileId);
    entry.state = state;
    for (const listener of [...entry.listeners]) {
      listener(state);
    }
  }

  /** Accepts only the documented URL form and puts the files origin in front if there is one. */
  private toLinks(url: FileUrl): FileLinks | undefined {
    const resolve = (path: string | undefined): string | undefined =>
      path && FILE_PATH.test(path) ? `${this.filesOrigin ?? ''}${path}` : undefined;
    const main = resolve(url.url);
    const original = resolve(url.originalUrl);
    const expiresAt = Date.parse(url.expiresAt);
    if (!main || !original || !Number.isFinite(expiresAt)) {
      return undefined;
    }
    return {
      url: main,
      originalUrl: original,
      thumbnailUrl: resolve(url.thumbnailUrl),
      pdfUrl: resolve(url.pdfUrl),
      expiresAt,
    };
  }

  private requireBoard(): string {
    if (!this.boardId) {
      throw new Error('BoardFiles.open(boardId) was not called');
    }
    return this.boardId;
  }

  private destroy(): void {
    this.destroyed = true;
    clearTimeout(this.renewTimer);
    clearTimeout(this.retryTimer);
    for (const entry of this.entries.values()) {
      this.stopPolling(entry);
      entry.listeners.clear();
      entry.links = undefined;
    }
  }
}

export function toMeta(file: BoardFile): FileMeta {
  return {
    id: file.id.toLowerCase(),
    name: file.name,
    mediaType: file.mediaType,
    kind: file.kind,
    size: file.size,
    conversion: file.conversion,
    pageCount: file.pageCount,
    width: file.width,
    height: file.height,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status: number }).status
    : undefined;
}
