/**
 * The text arithmetic of collaborative editing, without a DOM: the textarea editor
 * (text-editor.ts) and the models (story cards) write text through it.
 */
import * as Y from 'yjs';

import { BoardDoc } from '../model/board-doc.js';
import { MAX_TEXT_LENGTH } from '../model/types.js';

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

export interface DeltaOp {
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
