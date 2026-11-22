import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { BuiltinServices } from '../../../../../board-engine/blocks/builtin';
import { isEditableTarget } from '../../../../../board-engine/input/input-controller';
import { CLIPBOARD_MIME, WEB_CLIPBOARD_MIME, BoardDoc, type Point } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../board-engine/engine';
import { Theme } from '../../../../services/theme';

/** A Markdown code fence of Mermaid source, the whole pasted text. */
const MERMAID_FENCE = /^\s*```mermaid[^\n]*\n([\s\S]*?)\n?```\s*$/;

/** Files dropped onto or pasted into the canvas; `at` is the world point of a drop. */
export interface CanvasFiles {
  readonly files: File[];
  readonly at?: Point;
}

/**
 * Hosts the board engine (plain TypeScript, no Angular) in one element. Angular only creates
 * and destroys it and passes the read-only flag and the host services of the built-in blocks
 * (files); the engine draws and handles all input, copy and paste of blocks included. Files
 * dropped on the canvas or pasted while no text field has the focus go out as `files` (uploads,
 * architecture 3.6); this paste listener runs before the engine's and takes files and Mermaid
 * fences first (`preventDefault`), the engine leaves a taken paste alone.
 */
@Component({
  selector: 'drawboard-board-canvas',
  templateUrl: './board-canvas.html',
  // the engine positions its layers inside; the host must be a sized box. Position and size come
  // from the parent (board-page: `absolute inset-0`), so the host sets no `position` of its own -
  // a `relative` here would win over the parent's `absolute` and collapse the canvas to 0 px.
  host: {
    class: 'block',
    '(dragover)': 'dragOver($event)',
    '(drop)': 'drop($event)',
    '(document:paste)': 'paste($event)',
  },
})
export class BoardCanvas {
  private readonly theme = inject(Theme);

  /** The board's data. A new document (version restored) gets a new engine. */
  readonly board = input.required<BoardDoc>();
  readonly readOnly = input(false);
  /**
   * The board's id on the server (null: none, e.g. a board from a data URL). Copies carry it:
   * file blocks are pasted only into their own board. Read when an engine is created.
   */
  readonly boardId = input<string | null>(null);
  /** Services of the built-in blocks; read when an engine is created. */
  readonly services = input<BuiltinServices>({});
  /** Drop and paste of files are taken only when this is set (signed-in editors). */
  readonly canUpload = input(false);
  readonly files = output<CanvasFiles>();
  /** A ```mermaid fence pasted onto the canvas (architecture 3.7): its source. */
  readonly diagram = output<string>();

  /** The running engine once the view exists (toolbar and style panel talk to it). */
  readonly engine = signal<BoardEngine | undefined>(undefined);

  private readonly surface = viewChild.required<ElementRef<HTMLElement>>('surface');

  private readonly viewReady = signal(false);

  constructor() {
    afterNextRender(() => this.viewReady.set(true));
    effect(() => {
      const board = this.board();
      if (!this.viewReady()) {
        return;
      }
      untracked(() => {
        this.engine()?.destroy();
        this.engine.set(
          new BoardEngine(this.surface().nativeElement, board, {
            readOnly: this.readOnly(),
            services: this.services(),
            boardId: this.boardId(),
            theme: this.theme.resolved(),
          }),
        );
      });
    });
    effect(() => this.engine()?.setReadOnly(this.readOnly()));
    // light or dark: the engine only changes how it draws, the board's colours stay as stored
    effect(() => this.engine()?.setTheme(this.theme.resolved()));
    inject(DestroyRef).onDestroy(() => this.engine()?.destroy());
  }

  protected dragOver(event: DragEvent): void {
    if (this.canUpload() && event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  protected drop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!this.canUpload() || files.length === 0) {
      return;
    }
    event.preventDefault();
    this.files.emit({ files, at: this.engine()?.worldAtClient(event.clientX, event.clientY) });
  }

  protected paste(event: ClipboardEvent): void {
    const types = event.clipboardData?.types ?? [];
    // board content copied from a board: the engine pastes it (copy and paste of blocks)
    if (
      isEditableTarget(event.target) ||
      this.readOnly() ||
      types.includes(CLIPBOARD_MIME) ||
      types.includes(WEB_CLIPBOARD_MIME)
    ) {
      return;
    }
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length > 0) {
      if (this.canUpload()) {
        event.preventDefault();
        this.files.emit({ files });
      }
      return;
    }
    const fence = MERMAID_FENCE.exec(event.clipboardData?.getData('text/plain') ?? '');
    if (fence?.[1]) {
      event.preventDefault();
      this.diagram.emit(fence[1]);
    }
  }
}
