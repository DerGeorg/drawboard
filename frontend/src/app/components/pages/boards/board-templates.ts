import { HttpContext } from '@angular/common/http';
import {
  EnvironmentInjector,
  Service,
  Type,
  createEnvironmentInjector,
  inject,
} from '@angular/core';
import { Board, FilesService, PluginsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { FILE_TYPE } from '../../../../board-engine/blocks/file';
import type { FileState } from '../../../../board-engine/files/file-source';
import { CopyResult, importableCopy } from '../../../../board-engine/io/board-copy';
import { BoardFile, ImportError, boardToFile } from '../../../../board-engine/io/board-file';
import type { BoardDoc } from '../../../../board-engine/model/board-doc';
import type { BuiltinTemplate } from '../../../../board-engine/templates/builtin-templates';
import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { Toasts } from '../../../services/toasts';
import { ApiError } from '../../../util/api-error';
import { WithSpan } from '../../../util/tracing';
import { BoardCollab } from './board-collab';
import { BoardFiles } from './board-files';
import { BoardImporter } from './board-importer';
import { MAX_FILE_BYTES, MAX_VIDEO_BYTES } from './board-uploads';

/** How long one file may take to show up in the template's file list and URL answer. */
const FILE_LOOKUP_MS = 30_000;
/** A 429 is waited out and tried again this often at most (per download and per upload). */
export const MAX_RATE_LIMIT_RETRIES = 3;
/** Longest wait for one `Retry-After`, and the wait when the header is missing or unreadable. */
const MAX_RETRY_WAIT_MS = 60_000;
const DEFAULT_RETRY_WAIT_MS = 5_000;

/** A download answered 429; carries how long to wait. */
class RateLimited extends Error {
  constructor(readonly waitMs: number) {
    super('rate limited');
  }
}

/** `Retry-After` in seconds as milliseconds, capped; anything else is the default wait. */
function waitFrom(header: string | null | undefined): number {
  const seconds = header === null || header === undefined ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
    : DEFAULT_RETRY_WAIT_MS;
}

function retryWait(error: unknown): number | undefined {
  if (error instanceof RateLimited) {
    return error.waitMs;
  }
  if (error instanceof ApiError && error.status === 429) {
    return waitFrom(error.response.headers.get('Retry-After'));
  }
  return undefined;
}

/** What the files on a template board add up to (shown before a copy, T9). */
export interface FileSummary {
  count: number;
  bytes: number;
}

export interface CopyOptions {
  /** Title of the new board; default: the title of the source. */
  title?: string;
  /** Own folder for the new board; undefined = the top level. */
  folderId?: string;
  /**
   * The source board's live document, when the editor has it open: saves a second connection.
   * Without it the document is read over a connection of its own.
   */
  doc?: BoardDoc;
  /** false = copy without files: their blocks are left out. Default true. */
  files?: boolean;
}

/** The source document as it was read, and how to learn that it went away meanwhile. */
interface Reading {
  file: BoardFile;
  /** True once the server ended the template's session (access withdrawn, deleted, restored). */
  gone(): boolean;
  close(): void;
}

/**
 * Templates (architecture 3.12): a new board from a template is a copy made in the browser, the
 * same path as an import: read the template's document over a connection of its own,
 * `boardToFile`, validate it like an import (`importableCopy`: unknown or disabled block types
 * and invalid blocks are left out and counted, never written), `createBoard`, write the pieces
 * (BoardImporter). Files of the template belong to the template board, so each one is downloaded
 * through its signed URL (original variant only, no cookies, no referrer, no redirects) and
 * uploaded to the new board before the content is written; the block then points at the new
 * file. A file that cannot be copied keeps its old id (the block shows "not available") and one
 * message at the end says how many. If the template goes away during the copy (its connection is
 * closed by the server), the copy is cancelled and the half-made board is deleted. Signed URLs
 * stay in memory of this call only. Spans carry ids only, never titles or contents.
 */
@Service()
export class BoardTemplates {
  private readonly importer = inject(BoardImporter);
  private readonly filesApi = inject(FilesService);
  private readonly pluginsApi = inject(PluginsService);
  private readonly toasts = inject(Toasts);
  private readonly parent = inject(EnvironmentInjector);
  private readonly quiet = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

  /** The reader's connection; tests replace it with a fake. */
  collabType: Type<BoardCollab> = BoardCollab;
  /** Waits for a 429; tests replace it. */
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A new board from a built-in template. Undefined when it failed (a message was shown). */
  @WithSpan('BoardTemplates.fromBuiltin')
  async fromBuiltin(
    template: BuiltinTemplate,
    options: Pick<CopyOptions, 'title' | 'folderId'> = {},
  ): Promise<Board | undefined> {
    // the same validation as every other copy: one way in
    let content: CopyResult;
    try {
      content = importableCopy(template.file);
    } catch (error) {
      return this.cannotCopy(error);
    }
    const board = await this.importer.save(content.file, options.title || template.title, {
      folderId: options.folderId,
    });
    this.reportSkipped(board, content.skipped);
    return board;
  }

  /** A new board from a template board of the library. Undefined when it failed. */
  @WithSpan('BoardTemplates.fromBoard', {
    attributes: (source: Board) => ({ 'board.id': source.id }),
  })
  async fromBoard(source: Board, options: CopyOptions = {}): Promise<Board | undefined> {
    return this.copy(source, options, false);
  }

  /**
   * "Save as template": a copy of `board` with the template flag; the original stays as it was.
   * Lands on the top level of the user's own space. Undefined when it failed.
   */
  @WithSpan('BoardTemplates.saveAsTemplate', {
    attributes: (board: Board) => ({ 'board.id': board.id }),
  })
  async saveAsTemplate(
    board: Board,
    doc?: BoardDoc,
    options: Pick<CopyOptions, 'files'> = {},
  ): Promise<Board | undefined> {
    const copy = await this.copy(board, { doc, files: options.files }, true);
    if (copy) {
      this.toasts.success(`Saved as the template “${copy.title}”. Find it under Templates.`);
    }
    return copy;
  }

  /** How many files the board holds and how big they are together; zero when that is unknown. */
  @WithSpan('BoardTemplates.fileSummary', {
    attributes: (board: Board) => ({ 'board.id': board.id }),
  })
  async fileSummary(board: Board): Promise<FileSummary> {
    try {
      const list = await firstValueFrom(
        this.filesApi.listFiles({ boardId: board.id }, 'body', false, { context: this.quiet }),
      );
      return { count: list.items.length, bytes: list.items.reduce((sum, f) => sum + f.size, 0) };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  private async copy(
    source: Board,
    options: CopyOptions,
    template: boolean,
  ): Promise<Board | undefined> {
    const reading = await this.read(source, options.doc);
    if (!reading) {
      return undefined;
    }
    try {
      let content: CopyResult;
      try {
        content = importableCopy(reading.file, {
          pluginTypes: await this.enabledTypes(),
          omitTypes: options.files === false ? new Set([FILE_TYPE]) : undefined,
        });
      } catch (error) {
        return this.cannotCopy(error);
      }
      if (!content.file.blocks.some((b) => b.type === FILE_TYPE)) {
        reading.close(); // nothing to wait for any more
      }
      let missing = 0;
      let total = 0;
      const board = await this.importer.save(content.file, options.title || source.title, {
        folderId: options.folderId,
        template: template || undefined,
        prepare: async (target, file) => {
          const copied = await this.copyFiles(source.id, target.id, file, reading);
          missing = copied.missing;
          total = copied.total;
          return copied.file;
        },
      });
      this.reportSkipped(board, content.skipped);
      if (board && missing > 0) {
        this.toasts.error(
          `${missing} of ${total} ${total === 1 ? 'file' : 'files'} could not be copied. ` +
            `${missing === 1 ? 'Its block shows' : 'Their blocks show'} “not available”.`,
        );
      }
      return board;
    } finally {
      reading.close();
    }
  }

  private cannotCopy(error: unknown): undefined {
    if (error instanceof ImportError) {
      this.toasts.error(`This template cannot be copied: ${error.reason}.`);
      return undefined;
    }
    throw error;
  }

  private reportSkipped(board: Board | undefined, skipped: number): void {
    if (board && skipped > 0) {
      this.toasts.error(
        `${skipped} ${skipped === 1 ? 'block was' : 'blocks were'} not copied ` +
          '(unknown or disabled type, or invalid content).',
      );
    }
  }

  /** Block types of the plugins enabled on the instance; none when the list cannot be read. */
  private async enabledTypes(): Promise<ReadonlySet<string>> {
    try {
      const list = await firstValueFrom(
        this.pluginsApi.listEnabledPlugins('body', false, { context: this.quiet }),
      );
      return new Set(list.items.flatMap((p) => p.blockTypes.map((t) => t.type)));
    } catch {
      return new Set();
    }
  }

  /**
   * The template's content: from the open editor, or over a connection of its own that stays open
   * until `close()` so the copy notices when the template goes away.
   */
  private async read(source: Board, doc: BoardDoc | undefined): Promise<Reading | undefined> {
    if (doc) {
      return { file: boardToFile(doc, source.title), gone: () => false, close: () => undefined };
    }
    const injector = createEnvironmentInjector(
      [{ provide: BoardCollab, useClass: this.collabType }],
      this.parent,
    );
    let closed = false;
    const close = (): void => {
      if (!closed) {
        closed = true;
        injector.destroy();
      }
    };
    try {
      const collab = injector.get(BoardCollab);
      collab.connect(source.id);
      await collab.whenLoaded();
      const first = collab.doc();
      return {
        file: boardToFile(first, source.title),
        // 4403/4404 end the session ("denied"); 4410 replaces the document
        gone: () => collab.state()?.status === 'denied' || collab.doc() !== first,
        close,
      };
    } catch {
      close();
      this.toasts.error('The template could not be read.');
      return undefined;
    }
  }

  /**
   * Copies every file of the blocks to the new board and points the blocks at the copies. Files
   * that fail stay as they are: the block keeps the old id and shows "not available". Throws
   * when the template went away (the importer then deletes the new board).
   */
  private async copyFiles(
    sourceId: string,
    targetId: string,
    file: BoardFile,
    reading: Reading,
  ): Promise<{ file: BoardFile; missing: number; total: number }> {
    const ids = [
      ...new Set(
        file.blocks
          .filter((b) => b.type === FILE_TYPE)
          .map((b) => b.props['fileId'])
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (ids.length === 0) {
      return { file, missing: 0, total: 0 };
    }
    // BoardFiles of the SOURCE board: metadata and signed URLs, batched and validated (S4.4)
    const injector = createEnvironmentInjector([BoardFiles], this.parent);
    const copies = new Map<string, string>();
    try {
      const files = injector.get(BoardFiles);
      files.open(sourceId);
      const states = await Promise.all(ids.map((id) => this.lookup(files, id)));
      // one after the other: the upload limit is per minute and memory holds one file at a time
      for (const [i, state] of states.entries()) {
        this.assertPresent(reading);
        if (state?.status === 'ready' && !tooBig(state.file)) {
          const copy = await this.upload(targetId, state);
          if (copy) {
            copies.set(ids[i], copy);
          }
        }
      }
      this.assertPresent(reading);
    } finally {
      injector.destroy();
    }
    return {
      file: {
        ...file,
        blocks: file.blocks.map((b) => {
          const to = b.type === FILE_TYPE ? copies.get(String(b.props['fileId'])) : undefined;
          return to ? { ...b, props: { ...b.props, fileId: to } } : b;
        }),
      },
      missing: ids.length - copies.size,
      total: ids.length,
    };
  }

  private assertPresent(reading: Reading): void {
    if (reading.gone()) {
      throw new Error('The template is gone.');
    }
  }

  /** The first settled state of a file: ready, or undefined for missing, failed or too slow. */
  private lookup(files: BoardFiles, id: string): Promise<FileState | undefined> {
    return new Promise((resolve) => {
      const watching: { stop?: () => void } = {};
      let done = false;
      const finish = (state: FileState | undefined): void => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          // the listener runs once before watch() returns: stop after it did
          queueMicrotask(() => watching.stop?.());
          resolve(state);
        }
      };
      const timer = setTimeout(() => finish(undefined), FILE_LOOKUP_MS);
      watching.stop = files.watch(id, (state) => {
        if (state.status !== 'loading') {
          finish(state.status === 'ready' ? state : undefined);
        }
      });
    });
  }

  /** Downloads one file through its signed URL and uploads it to the new board. New id or undefined. */
  private async upload(
    targetId: string,
    state: Extract<FileState, { status: 'ready' }>,
  ): Promise<string | undefined> {
    try {
      // the original variant only, never thumbnail or pdf
      const url = state.links.originalUrl;
      const blob = await this.retrying(() => this.download(url));
      if (blob.size > (state.file.kind === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) {
        return undefined;
      }
      const file = new File([blob], state.file.name, { type: state.file.mediaType });
      const stored = await this.retrying(() =>
        firstValueFrom(
          this.filesApi.uploadFile({ boardId: targetId, file }, 'body', false, {
            context: this.quiet,
          }),
        ),
      );
      return stored.id.toLowerCase();
    } catch {
      return undefined;
    }
  }

  private async download(url: string): Promise<Blob> {
    const response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    if (response.status === 429) {
      throw new RateLimited(waitFrom(response.headers.get('Retry-After')));
    }
    if (!response.ok) {
      throw new Error(`download failed with ${response.status}`);
    }
    return response.blob();
  }

  /** Runs `attempt`; a 429 is waited out (as `Retry-After` says, capped) and tried again. */
  private async retrying<T>(attempt: () => Promise<T>): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        const wait = n < MAX_RATE_LIMIT_RETRIES ? retryWait(error) : undefined;
        if (wait === undefined) {
          throw error;
        }
        await this.wait(wait);
      }
    }
  }
}

/** Metadata already over the limits of an upload: no point in downloading it (S4.1). */
function tooBig(file: { kind: string; size: number }): boolean {
  return file.size > (file.kind === 'VIDEO' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES);
}
