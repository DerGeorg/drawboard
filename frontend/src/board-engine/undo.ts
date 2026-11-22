import * as Y from 'yjs';

import { BoardDoc, LOCAL_ORIGIN, Emitter } from '@apps/drawboard-engine';

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Local undo/redo over blocks, connectors and strokes. Only transactions with LOCAL_ORIGIN are
 * tracked, so edits that arrive from other participants are never undone here.
 */
export class History {
  readonly changed = new Emitter<HistoryState>();
  private readonly manager: Y.UndoManager;

  constructor(board: BoardDoc) {
    this.manager = new Y.UndoManager([board.blocksMap, board.connectorsMap, board.strokesMap], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 500,
    });
    const emit = (): void => this.changed.emit(this.state);
    this.manager.on('stack-item-added', emit);
    this.manager.on('stack-item-popped', emit);
    this.manager.on('stack-cleared', emit);
  }

  get state(): HistoryState {
    return {
      canUndo: this.manager.undoStack.length > 0,
      canRedo: this.manager.redoStack.length > 0,
    };
  }

  undo(): void {
    this.manager.stopCapturing();
    this.manager.undo();
  }

  redo(): void {
    this.manager.stopCapturing();
    this.manager.redo();
  }

  /** The next change starts a new undo step. */
  stopCapturing(): void {
    this.manager.stopCapturing();
  }

  destroy(): void {
    this.manager.destroy();
    this.changed.clear();
  }
}
