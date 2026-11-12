import * as Y from 'yjs';

import { BoardDoc, LOCAL_ORIGIN } from '../model/board-doc';
import { MAX_TEXT_LENGTH } from '../model/types';

export interface TextDiff {
  index: number;
  remove: number;
  insert: string;
}

/** The smallest single edit that turns `before` into `after` (common prefix and suffix). */
export function textDiff(before: string, after: string): TextDiff {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { index: start, remove: endBefore - start, insert: after.slice(start, endAfter) };
}

interface DeltaOp {
  insert?: string | object;
  retain?: number;
  delete?: number;
}

/** Where a caret at `index` ends up after the edit described by a Y.Text delta. */
export function transformIndex(delta: DeltaOp[], index: number): number {
  let result = index;
  let oldPos = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      oldPos += op.retain;
    } else if (op.insert !== undefined) {
      if (oldPos <= index) {
        result += typeof op.insert === 'string' ? op.insert.length : 1;
      }
    } else if (op.delete !== undefined) {
      if (oldPos < index) {
        result -= Math.min(op.delete, index - oldPos);
      }
      oldPos += op.delete;
    }
  }
  return Math.max(0, result);
}

/** Writes the difference between two strings into a Y.Text as one delete and one insert. */
export function applyTextDiff(board: BoardDoc, text: Y.Text, after: string): void {
  const diff = textDiff(text.toString(), after.slice(0, MAX_TEXT_LENGTH));
  if (diff.remove === 0 && diff.insert === '') {
    return;
  }
  board.transact(() => {
    if (diff.remove > 0) {
      text.delete(diff.index, diff.remove);
    }
    if (diff.insert) {
      text.insert(diff.index, diff.insert);
    }
  });
}

export interface TextEditSession {
  readonly blockId: string;
  stop(): void;
}

/**
 * A textarea laid over one block, bound to the block's Y.Text: local typing becomes a minimal
 * delete/insert pair, remote edits move the caret instead of resetting it.
 */
export function startTextEditor(
  board: BoardDoc,
  host: HTMLElement,
  blockId: string,
  onStop: () => void,
  options: { maxLength?: number } = {},
): TextEditSession | undefined {
  const ytext = board.getText(blockId);
  if (!ytext) {
    return undefined;
  }
  const doc = host.ownerDocument;
  const ta = doc.createElement('textarea');
  ta.className = 'be-text-editor';
  const maxLength = Math.min(options.maxLength ?? MAX_TEXT_LENGTH, MAX_TEXT_LENGTH);
  // a short text (a title) is one line: compact, and Enter ends the edit
  const singleLine = maxLength < MAX_TEXT_LENGTH;
  ta.maxLength = maxLength;
  ta.value = ytext.toString();
  ta.spellcheck = false;
  ta.style.cssText =
    `position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:${singleLine ? '6px 8px' : '12px'};resize:none;` +
    'border:2px solid var(--be-selection,#2563eb);border-radius:4px;background:rgba(255,255,255,.55);color:#1f2937;' +
    `font:${singleLine ? '600 13px' : 'var(--be-font-size,16px)'}/1.35 system-ui,sans-serif;outline:none;overflow:${singleLine ? 'hidden' : 'auto'};z-index:1`;
  host.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let stopped = false;
  const onInput = (): void => {
    if (singleLine && /[\r\n]/.test(ta.value)) {
      ta.value = ta.value.replace(/[\r\n]+/g, ' ');
    }
    applyTextDiff(board, ytext, ta.value.slice(0, maxLength));
  };
  const observer = (event: Y.YTextEvent): void => {
    if (event.transaction.origin === LOCAL_ORIGIN) {
      return;
    }
    const delta = event.delta as DeltaOp[];
    const start = transformIndex(delta, ta.selectionStart);
    const end = transformIndex(delta, ta.selectionEnd);
    ta.value = ytext.toString();
    ta.setSelectionRange(start, end);
  };
  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    ytext.unobserve(observer);
    ta.removeEventListener('input', onInput);
    ta.removeEventListener('blur', stop);
    ta.removeEventListener('keydown', onKey);
    ta.remove();
    onStop();
  };
  const onKey = (e: KeyboardEvent): void => {
    e.stopPropagation();
    if (e.key === 'Escape' || (singleLine && e.key === 'Enter' && !e.isComposing)) {
      e.preventDefault();
      stop();
    }
  };
  ta.addEventListener('input', onInput);
  ta.addEventListener('blur', stop);
  ta.addEventListener('keydown', onKey);
  ytext.observe(observer);
  return { blockId, stop };
}
