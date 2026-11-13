import {
  EnvironmentInjector,
  Service,
  Type,
  createEnvironmentInjector,
  inject,
} from '@angular/core';
import { Board, BoardsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { BoardFile, splitBoardFile, writeBoardFile } from '../../../../board-engine/io/board-file';
import { Toasts } from '../../../services/toasts';
import { ApiError } from '../../../util/api-error';
import { WithSpan } from '../../../util/tracing';
import { BoardActions } from './board-actions';
import { BoardCollab } from './board-collab';

/** One piece of a big import stays well below the 1 MiB UPDATE frame of the protocol. */
export const IMPORT_PIECE_BYTES = 200_000;
export const DEFAULT_IMPORT_TITLE = 'Imported board';

/** What a save may add to a plain import. */
export interface SaveOptions {
  /** Own folder to create the board in; undefined = the top level. */
  folderId?: string;
  /** Create the board as a template. */
  template?: boolean;
  /**
   * Runs after the board exists and before its content is written: may return a changed copy of
   * the file (templates upload their files to the new board here and point the blocks at them).
   * A throw cancels the save like a failed write.
   */
  prepare?: (board: Board, file: BoardFile) => Promise<BoardFile>;
}

/**
 * Creates a NEW board from a validated board file: `createBoard`, then the normal collaboration
 * traffic writes the document (no API of its own, architecture 3.9). The board is written piece
 * by piece, each acknowledged before the next, so no UPDATE frame exceeds the protocol limit.
 * A connection of its own (a BoardCollab in a throw-away injector) does the writing, so the
 * board that is open in the editor - if any - is not touched.
 */
@Service()
export class BoardImporter {
  private readonly actions = inject(BoardActions);
  private readonly boardsApi = inject(BoardsService);
  private readonly toasts = inject(Toasts);
  private readonly parent = inject(EnvironmentInjector);

  /** The writer's connection; tests replace it with a fake. */
  collabType: Type<BoardCollab> = BoardCollab;

  /** The new board, or undefined when it failed (a message was shown). */
  @WithSpan('BoardImporter.save')
  async save(
    file: BoardFile,
    title?: string,
    options: SaveOptions = {},
  ): Promise<Board | undefined> {
    let board: Board;
    try {
      // started before the first await: BoardActions' span becomes a child of this one
      board = await this.actions.create(
        title?.trim() || file.title.trim() || DEFAULT_IMPORT_TITLE,
        undefined,
        options.folderId,
        options.template,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        return undefined;
      }
      throw error;
    }
    let content: BoardFile;
    try {
      // before the connection opens: copying files can take a while
      content = options.prepare ? await options.prepare(board, file) : file;
    } catch {
      this.toasts.error('The board could not be written. The import was cancelled.');
      await this.discard(board);
      return undefined;
    }
    const injector = createEnvironmentInjector(
      [{ provide: BoardCollab, useClass: this.collabType }],
      this.parent,
    );
    try {
      const collab = injector.get(BoardCollab);
      collab.connect(board.id);
      await collab.whenSynced();
      for (const piece of splitBoardFile(content, IMPORT_PIECE_BYTES)) {
        writeBoardFile(collab.doc(), piece);
        await collab.whenFlushed();
      }
      return board;
    } catch {
      this.toasts.error('The board could not be written. The import was cancelled.');
      await this.discard(board);
      return undefined;
    } finally {
      injector.destroy();
    }
  }

  /** Best effort: an import that failed halfway should not leave a half-filled board behind. */
  private async discard(board: Board): Promise<void> {
    try {
      await firstValueFrom(this.boardsApi.deleteBoard({ boardId: board.id }));
    } catch {
      // the board stays in the library, the user can delete it there
    }
  }
}
