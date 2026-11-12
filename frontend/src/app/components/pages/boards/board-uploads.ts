import { HttpContext, HttpEventType } from '@angular/common/http';
import { DestroyRef, Service, inject, signal } from '@angular/core';
import { BoardFile, FilesService } from '@apps/drawboard-api';
import { Subscription } from 'rxjs';

import { FILE_TYPE, fileBlockSize } from '../../../../board-engine/blocks/file';
import type { BoardEngine } from '../../../../board-engine/engine';
import type { Point } from '../../../../board-engine/model/types';
import { ErrorMessages } from '../../../services/error-messages';
import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { ApiError } from '../../../util/api-error';
import { BoardFiles } from './board-files';

/** Default limits of the backend (S4.1; configurable there, the server stays the authority). */
export const MAX_FILE_BYTES = 50 * 1_000_000;
export const MAX_VIDEO_BYTES = 500 * 1_000_000;
/** The backend allows 30 uploads per user and minute (S7.3): one drop never asks for more. */
export const MAX_FILES_PER_DROP = 30;

/** Extensions the backend accepts (S4.2, allowlist); the server sniffs the content anyway. */
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const VIDEO = ['mp4', 'webm'];
const DOCUMENT = ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];
export const ACCEPTED_EXTENSIONS = [...IMAGE, ...VIDEO, ...DOCUMENT].map((e) => `.${e}`);

/** Shown next to the upload button and in the upload panel. */
export const UPLOAD_LIMITS_TEXT =
  'Images, PDF and Office files up to 50 MB, videos (MP4, WebM) up to 500 MB.';

export interface UploadItem {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  /** 0..1 */
  readonly progress: number;
  readonly status: 'queued' | 'uploading' | 'done' | 'failed';
  readonly error?: string;
  readonly requestId?: string;
}

/**
 * Uploads to the open board (S4.1): checks the obvious limits before sending anything, uploads
 * one file at a time with progress, then places a file block where the files were dropped (or
 * in the middle of the view). Errors stay in the upload panel with the request id - the server
 * decides type (by content), size and quota.
 */
@Service({ autoProvided: false })
export class BoardUploads {
  private readonly api = inject(FilesService);
  private readonly files = inject(BoardFiles);
  private readonly messages = inject(ErrorMessages);

  private readonly list = signal<readonly UploadItem[]>([]);
  readonly items = this.list.asReadonly();

  private engine: BoardEngine | undefined;
  private boardId: string | undefined;
  private nextId = 1;
  private readonly queue: { id: number; file: File; at: Point | undefined }[] = [];
  private running: Subscription | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.running?.unsubscribe());
  }

  open(boardId: string): void {
    this.boardId = boardId;
  }

  bind(engine: BoardEngine | undefined): void {
    this.engine = engine;
  }

  /** Queues `files`; blocks appear around `at` (world), else in the middle of the view. */
  upload(files: readonly File[], at?: Point): void {
    files.forEach((file, index) => {
      const id = this.nextId++;
      const refusal = index >= MAX_FILES_PER_DROP ? 'At most 30 files at once.' : check(file);
      this.list.update((all) => [
        ...all,
        {
          id,
          name: file.name,
          size: file.size,
          progress: 0,
          status: refusal ? 'failed' : 'queued',
          error: refusal,
        },
      ]);
      if (!refusal) {
        const offset = this.queue.length * 24;
        this.queue.push({ id, file, at: at && { x: at.x + offset, y: at.y + offset } });
      }
    });
    this.next();
  }

  /** Removes finished and failed entries (the panel's close button). */
  clearFinished(): void {
    this.list.update((all) => all.filter((i) => i.status === 'queued' || i.status === 'uploading'));
  }

  private next(): void {
    if (this.running || !this.boardId) {
      return;
    }
    const job = this.queue.shift();
    if (!job) {
      return;
    }
    this.patch(job.id, { status: 'uploading' });
    const context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);
    this.running = this.api
      .uploadFile({ boardId: this.boardId, file: job.file }, 'events', true, { context })
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress && event.total) {
            this.patch(job.id, { progress: Math.min(0.99, event.loaded / event.total) });
          } else if (event.type === HttpEventType.Response && event.body) {
            this.placed(job.id, event.body, job.at);
          }
        },
        error: (error: unknown) => {
          const api = error instanceof ApiError ? error : undefined;
          this.patch(job.id, {
            status: 'failed',
            error: api ? this.messages.text(api.problem) : 'The upload failed.',
            requestId: api?.requestId,
          });
          this.done();
        },
        complete: () => this.done(),
      });
  }

  private done(): void {
    this.running = undefined;
    this.next();
  }

  private placed(id: number, file: BoardFile, at: Point | undefined): void {
    this.files.remember(file);
    this.patch(id, { status: 'done', progress: 1 });
    const engine = this.engine;
    if (engine) {
      engine.insertBlock({
        type: FILE_TYPE,
        at: at ?? engine.visibleCenter(),
        size: fileBlockSize(file),
        props: { fileId: file.id.toLowerCase() },
      });
    }
  }

  private patch(id: number, change: Partial<UploadItem>): void {
    this.list.update((all) => all.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }
}

/** The checks the browser can make before uploading; undefined = fine. */
export function check(file: File): string | undefined {
  const ext = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (ext === 'svg' || file.type === 'image/svg+xml') {
    return 'SVG images are not allowed.';
  }
  if (!ext || ![...IMAGE, ...VIDEO, ...DOCUMENT].includes(ext)) {
    return 'This file type is not supported.';
  }
  if (file.size === 0) {
    return 'The file is empty.';
  }
  const limit = VIDEO.includes(ext) ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) {
    return `The file is larger than ${limit / 1_000_000} MB.`;
  }
  return undefined;
}
