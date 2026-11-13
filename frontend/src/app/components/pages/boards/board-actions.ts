import { HttpContext } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { Board, BoardsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { Toasts } from '../../../services/toasts';
import { ApiError } from '../../../util/api-error';
import { WithSpan } from '../../../util/tracing';

/**
 * The commands of the board domain - the frontend's use cases. Every public method is a span
 * (`@WithSpan('BoardActions.<method>')`, enforced by @ci/with-span-on-actions), so a trace reads
 * "BoardCreate.submit > BoardActions.create > POST > backend". Span attributes carry ids only,
 * never titles.
 *
 * delete: failures are already toasted by the error interceptor (with request id); callers only
 * learn whether the command worked. create/rename: the ApiError is re-thrown so the caller can
 * show violations at its fields or react to a 409.
 */
@Service()
export class BoardActions {
  private readonly boardsApi = inject(BoardsService);
  private readonly toasts = inject(Toasts);

  /**
   * Creates a board (`template`: as a template). `context`: e.g. FIELD_ERRORS_HANDLED_LOCALLY of
   * the calling form.
   */
  @WithSpan('BoardActions.create')
  create(
    title: string,
    context?: HttpContext,
    folderId?: string,
    template?: boolean,
  ): Promise<Board> {
    return firstValueFrom(
      this.boardsApi.createBoard({ newBoard: { title, folderId, template } }, 'body', false, {
        context,
      }),
    );
  }

  /**
   * Switches the template flag - the owner's job (anyone else gets 403) - optimistic locking with
   * `board.version`. Resolves to the changed board; undefined when it failed (toasted already).
   */
  @WithSpan('BoardActions.setTemplate', {
    attributes: (board: Board) => ({ 'board.id': board.id }),
  })
  async setTemplate(board: Board, template: boolean): Promise<Board | undefined> {
    try {
      return await firstValueFrom(
        this.boardsApi.updateBoard({
          boardId: board.id,
          boardUpdate: { title: board.title, template, version: board.version },
        }),
      );
    } catch (error) {
      if (error instanceof ApiError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Saves a new title - optimistic locking: `board.version` as loaded; a newer one -> 409. */
  @WithSpan('BoardActions.rename', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  rename(board: Board, title: string, context?: HttpContext): Promise<Board> {
    const boardUpdate = { title, version: board.version };
    return firstValueFrom(
      this.boardsApi.updateBoard({ boardId: board.id, boardUpdate }, 'body', false, { context }),
    );
  }

  /** Moves the board to the trash (restorable for 30 days). True when it is gone. */
  @WithSpan('BoardActions.delete', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  delete(board: Board): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.boardsApi.deleteBoard({ boardId: board.id })),
      `"${board.title}" was moved to the trash.`,
    );
  }

  /**
   * Moves the board into a folder of the owner's space (null = the root), optimistic locking with
   * `board.version`. Resolves to the moved board; undefined when it failed (toasted already,
   * e.g. 409: someone changed the board first).
   */
  @WithSpan('BoardActions.move', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  async move(board: Board, folderId: string | null): Promise<Board | undefined> {
    try {
      return await firstValueFrom(
        this.boardsApi.moveBoard({
          boardId: board.id,
          boardMove: { folderId, version: board.version },
        }),
      );
    } catch (error) {
      if (error instanceof ApiError) {
        return undefined;
      }
      throw error;
    }
  }

  /** Takes the board out of the trash. True when it worked. */
  @WithSpan('BoardActions.restore', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  restore(board: Board): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.boardsApi.restoreBoard({ boardId: board.id })),
      `"${board.title}" was restored.`,
    );
  }

  /** Deletes a board from the trash for good (cannot be undone). True when it is gone. */
  @WithSpan('BoardActions.purge', { attributes: (board: Board) => ({ 'board.id': board.id }) })
  purge(board: Board): Promise<boolean> {
    return this.succeeded(
      firstValueFrom(this.boardsApi.purgeBoard({ boardId: board.id })),
      `"${board.title}" was deleted for good.`,
    );
  }

  /** True after a success (with a toast); false when the ApiError was already toasted. */
  private async succeeded(call: Promise<unknown>, message: string): Promise<boolean> {
    try {
      await call;
      this.toasts.success(message);
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        return false;
      }
      throw error;
    }
  }
}
