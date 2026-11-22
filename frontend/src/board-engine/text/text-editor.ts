import * as Y from 'yjs';

import {
  BoardDoc,
  LOCAL_ORIGIN,
  MAX_TEXT_LENGTH,
  DeltaOp,
  applyTextDiff,
  transformIndex,
} from '@apps/drawboard-engine';

export interface TextEditSession {
  readonly blockId: string;
  stop(): void;
  /**
   * Puts `text` at the caret (replacing the selection) the way typing does: through the input
   * path, so it becomes one Yjs edit. False if it would exceed the limit or the edit ended.
   */
  insert(text: string): boolean;
  /**
   * Keeps the editor open when the textarea loses the focus (to a panel beside it); the returned
   * function ends the hold and gives the focus back, with the caret where it was.
   */
  hold(): () => void;
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
    'border:2px solid var(--be-selection,#2563eb);border-radius:4px;background:var(--be-editor-bg,rgba(255,255,255,.55));color:var(--be-editor-text,#1f2937);' +
    `font:${singleLine ? '600 13px' : 'var(--be-font-size,16px)'}/1.35 system-ui,sans-serif;outline:none;overflow:${singleLine ? 'hidden' : 'auto'};z-index:1`;
  host.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let stopped = false;
  let holds = 0;
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
    ta.removeEventListener('blur', onBlur);
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
  const onBlur = (): void => {
    if (holds === 0) {
      stop();
    }
  };
  const insert = (text: string): boolean => {
    const value = singleLine ? text.replace(/[\r\n]+/g, ' ') : text;
    if (stopped || value === '') {
      return false;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (ta.value.length - (end - start) + value.length > maxLength) {
      return false;
    }
    ta.focus({ preventScroll: true });
    ta.setRangeText(value, start, end, 'end');
    onInput();
    return true;
  };
  const hold = (): (() => void) => {
    holds++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      holds--;
      if (!stopped) {
        ta.focus({ preventScroll: true });
      }
    };
  };
  ta.addEventListener('input', onInput);
  ta.addEventListener('blur', onBlur);
  ta.addEventListener('keydown', onKey);
  ytext.observe(observer);
  return { blockId, stop, insert, hold };
}
