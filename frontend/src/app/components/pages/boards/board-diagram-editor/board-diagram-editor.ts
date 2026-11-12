import { Component, computed, effect, input, output, signal } from '@angular/core';

import { MAX_MERMAID_BYTES, byteLength } from '../../../../../board-engine/blocks/mermaid';
import { BoardEngine } from '../../../../../board-engine/engine';
import { formatBytes } from '../../../../util/format-bytes';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';

/**
 * The side panel to write a diagram's Mermaid source (architecture 3.7). The source is the
 * block's Y.Text: every keystroke becomes the smallest edit of it, the block on the canvas is
 * the live preview, and edits of others show up here. More than 50 KB is never written (S5.1).
 */
@Component({
  selector: 'drawboard-board-diagram-editor',
  imports: [Icon],
  templateUrl: './board-diagram-editor.html',
  host: { '(keydown.escape)': 'close()' },
})
export class BoardDiagramEditor {
  readonly engine = input.required<BoardEngine>();
  readonly blockId = input.required<string>();
  readonly closed = output();

  protected readonly source = signal('');
  protected readonly readOnly = signal(false);
  protected readonly tooLarge = signal(false);
  protected readonly limit = formatBytes(MAX_MERMAID_BYTES);
  protected readonly size = computed(() => formatBytes(byteLength(this.source())));

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      const id = this.blockId();
      this.source.set(engine.board.textOf(id));
      this.readOnly.set(engine.readOnly);
      const off = engine.board.observe((change) => {
        if (!change.blocks.has(id)) {
          return;
        }
        if (!engine.board.hasBlock(id)) {
          this.closed.emit(); // deleted (by anyone, or undone)
        } else if (!change.local) {
          this.source.set(engine.board.textOf(id));
        }
      });
      onCleanup(off);
    });
  }

  @WithSpan('BoardDiagramEditor.edit')
  protected edit(value: string): void {
    if (byteLength(value) > MAX_MERMAID_BYTES) {
      this.tooLarge.set(true);
      return;
    }
    this.tooLarge.set(false);
    this.source.set(value);
    this.engine().setBlockText(this.blockId(), value);
  }

  @WithSpan('BoardDiagramEditor.close')
  protected close(): void {
    this.closed.emit();
  }
}
