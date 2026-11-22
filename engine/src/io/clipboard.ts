import { FILE_TYPE } from '../model/block-types.js';
import { BoardDoc } from '../model/board-doc.js';
import { withDescendants } from '../model/frames.js';
import { cellsToTables } from '../model/tables.js';
import { ConnectorEnd, Point, Rect, SCHEMA_VERSION, isBlockEnd } from '../model/types.js';
import { pointsBounds, unionRects } from '../util/geometry.js';
import {
  BoardFile,
  FileBlock,
  FileConnector,
  FileStroke,
  ImportError,
  acceptsBlockType,
  blockToFile,
  connectorToFile,
  parseBoardFile,
  strokeToFile,
  writeBoardFile,
} from './board-file.js';

/**
 * Copy and paste of board content through the system clipboard (`copy`/`cut`/`paste`
 * ClipboardEvents, synchronous `setData`/`getData`, no permission prompt).
 *
 * The clipboard is UNTRUSTED input - any page or program can put anything under our MIME type.
 * A paste therefore goes through exactly the validators of the `.drawboard` import (S5.5,
 * `parseBoardFile`: per-type props, `Object.hasOwn` lookups, finite coordinates, references)
 * with smaller limits, after a size check on the raw text and before anything reaches the
 * document. Envelope:
 *
 * ```
 * { "drawboard": "clipboard", "version": 1, "sourceBoard": "<board uuid>" | null,
 *   "content": <board.json: schemaVersion, title, blocks, connectors, strokes> }
 * ```
 */

/** Written with `setData` and read back on paste. */
export const CLIPBOARD_MIME = 'application/x-drawboard+json';
/**
 * The async Clipboard API's name for the same custom format; read on paste in case another
 * tool wrote it that way. We never write it: `setData` in a ClipboardEvent knows no `web `
 * formats, and the async API would need a permission prompt.
 */
export const WEB_CLIPBOARD_MIME = 'web application/x-drawboard+json';
export const CLIPBOARD_VERSION = 1;

export const CLIPBOARD_LIMITS = {
  maxBlocks: 2_000,
  maxConnectors: 2_000,
  maxStrokes: 2_000,
  /** UTF-8 bytes of the clipboard text, checked before it is parsed. */
  maxBytes: 512 * 1024,
} as const;

/** Repeated pastes at the same spot step by this much (world units). */
export const PASTE_OFFSET = 20;

/** What goes onto the system clipboard. */
export interface ClipboardContent {
  /** The envelope, under CLIPBOARD_MIME. */
  readonly json: string;
  /** `text/plain`: the texts of the copied blocks, one per line. */
  readonly text: string;
}

/** A parsed and validated envelope. */
export interface ClipboardEnvelope {
  readonly sourceBoard: string | null;
  readonly content: BoardFile;
  /** Blocks left out before validation because their type is not available here. */
  readonly skippedTypes: number;
}

export interface CopySet {
  readonly blocks: string[];
  readonly connectors: string[];
  readonly strokes: string[];
}

export type CopyResult =
  { readonly content: ClipboardContent; readonly set: CopySet } | { readonly error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** UTF-8 length of a string without encoding it. */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * What a copy of `ids` takes: the selected blocks and strokes (a table cell: its table),
 * everything inside selected frames, the selected connectors whose block ends are copied too, and every connector whose
 * two ends are copied blocks.
 */
export function copySet(board: BoardDoc, ids: readonly string[]): CopySet {
  // a cell is copied as its whole table
  const blocks = withDescendants(
    board,
    cellsToTables(
      board,
      ids.filter((id) => board.hasBlock(id)),
    ),
  );
  const inSet = new Set(blocks);
  const strokes = ids.filter((id) => board.getStroke(id) !== undefined);
  const selected = new Set(ids);
  const attached = (end: ConnectorEnd): boolean => !isBlockEnd(end) || inSet.has(end.block);
  const connectors = board
    .connectors()
    .filter((c) => attached(c.from) && attached(c.to))
    .filter(
      (c) => selected.has(c.id) || (isBlockEnd(c.from) && isBlockEnd(c.to)), // both ends are copied blocks
    )
    .map((c) => c.id);
  return { blocks, connectors, strokes };
}

/** Reading order: top to bottom, then left to right. */
function readingOrder(a: FileBlock, b: FileBlock): number {
  return a.y - b.y || a.x - b.x;
}

/**
 * The selection as clipboard content. `sourceBoard` goes into the envelope so file blocks can
 * be refused on other boards (their file ids belong to this board, S4.4).
 */
export function copyToClipboard(
  board: BoardDoc,
  ids: readonly string[],
  sourceBoard: string | null,
): CopyResult {
  const set = copySet(board, ids);
  if (
    set.blocks.length > CLIPBOARD_LIMITS.maxBlocks ||
    set.connectors.length > CLIPBOARD_LIMITS.maxConnectors ||
    set.strokes.length > CLIPBOARD_LIMITS.maxStrokes
  ) {
    return { error: 'The selection is too large to copy (at most 2000 items of each kind).' };
  }
  const inSet = new Set(set.blocks);
  const blocks = set.blocks.flatMap((id) => {
    const b = board.getBlock(id);
    // a parent that is not copied along is no parent of the copy
    return b
      ? [{ ...blockToFile(board, b), parent: b.parent && inSet.has(b.parent) ? b.parent : null }]
      : [];
  });
  const content: BoardFile = {
    schemaVersion: SCHEMA_VERSION,
    title: '',
    blocks,
    connectors: set.connectors.flatMap((id) => {
      const c = board.getConnector(id);
      return c ? [connectorToFile(c)] : [];
    }),
    strokes: set.strokes.flatMap((id) => {
      const s = board.getStroke(id);
      return s ? [strokeToFile(s)] : [];
    }),
  };
  const json = JSON.stringify({
    drawboard: 'clipboard',
    version: CLIPBOARD_VERSION,
    sourceBoard,
    content,
  });
  if (utf8Bytes(json) > CLIPBOARD_LIMITS.maxBytes) {
    return { error: 'The selection is too large to copy (more than 512 KB).' };
  }
  const text = [...blocks]
    .sort(readingOrder)
    .map((b) => (b.text ?? '').trim())
    .filter((t) => t !== '')
    .join('\n');
  return { content: { json, text }, set };
}

function clipboardError(reason: string): ImportError {
  return new ImportError(`Nothing was pasted: ${reason}.`, reason);
}

/**
 * Removes blocks whose type cannot be pasted here (plugins that are not enabled on this
 * board) from the raw content, with the connectors attached to them and the parent links to
 * them - BEFORE validation, so the rest can still be pasted. Anything that is not the expected
 * shape is left alone for `parseBoardFile` to refuse.
 */
function withoutUnavailableTypes(
  raw: unknown,
  pluginTypes: ReadonlySet<string>,
): { raw: unknown; skipped: number } {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw['blocks']) ||
    raw['blocks'].length > CLIPBOARD_LIMITS.maxBlocks
  ) {
    return { raw, skipped: 0 };
  }
  const removed = new Set<string>();
  let skipped = 0;
  const blocks = (raw['blocks'] as unknown[]).filter((b) => {
    const drop =
      isRecord(b) && typeof b['type'] === 'string' && !acceptsBlockType(b['type'], pluginTypes);
    skipped += drop ? 1 : 0;
    if (drop && typeof b['id'] === 'string') {
      removed.add(b['id']);
    }
    return !drop;
  });
  if (skipped === 0) {
    return { raw, skipped: 0 };
  }
  const isRemoved = (id: unknown): boolean => typeof id === 'string' && removed.has(id);
  const endRemoved = (end: unknown): boolean => isRecord(end) && isRemoved(end['block']);
  const connectors = Array.isArray(raw['connectors'])
    ? (raw['connectors'] as unknown[]).filter(
        (c) => !(isRecord(c) && (endRemoved(c['from']) || endRemoved(c['to']))),
      )
    : raw['connectors'];
  return {
    raw: {
      ...raw,
      blocks: blocks.map((b) =>
        isRecord(b) && isRemoved(b['parent']) ? { ...b, parent: null } : b,
      ),
      connectors,
    },
    skipped,
  };
}

/**
 * Parses and validates clipboard text. Throws an ImportError whose `message` is for the user.
 * `pluginTypes`: block types of the plugins enabled on the target board (see ParseOptions).
 */
export function parseClipboard(
  json: string,
  options: { pluginTypes?: ReadonlySet<string> } = {},
): ClipboardEnvelope {
  // cheap bound first: a UTF-16 unit is at least one UTF-8 byte
  if (json.length > CLIPBOARD_LIMITS.maxBytes || utf8Bytes(json) > CLIPBOARD_LIMITS.maxBytes) {
    throw clipboardError('the clipboard holds more than 512 KB');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw clipboardError('the clipboard does not hold board content');
  }
  if (!isRecord(raw) || raw['drawboard'] !== 'clipboard') {
    throw clipboardError('the clipboard does not hold board content');
  }
  if (raw['version'] !== CLIPBOARD_VERSION) {
    throw clipboardError('the content comes from a newer version of Drawboard');
  }
  const source = raw['sourceBoard'] ?? null;
  if (source !== null && (typeof source !== 'string' || !UUID.test(source))) {
    throw clipboardError('the content names no valid source board');
  }
  const pluginTypes = options.pluginTypes ?? new Set<string>();
  const { raw: content, skipped } = withoutUnavailableTypes(raw['content'], pluginTypes);
  try {
    return {
      sourceBoard: source === null ? null : source.toLowerCase(),
      content: parseBoardFile(content, {
        maxBlocks: CLIPBOARD_LIMITS.maxBlocks,
        maxConnectors: CLIPBOARD_LIMITS.maxConnectors,
        maxStrokes: CLIPBOARD_LIMITS.maxStrokes,
        pluginTypes,
      }),
      skippedTypes: skipped,
    };
  } catch (error) {
    throw error instanceof ImportError ? clipboardError(error.reason) : error;
  }
}

export interface PasteResult {
  /** New ids of everything pasted (blocks, connectors, strokes). */
  readonly ids: string[];
  /** New ids of the pasted blocks whose parent is not pasted with them. */
  readonly topLevel: string[];
  /** File blocks left out: they belong to another board. */
  readonly droppedFiles: number;
}

function contentBounds(file: BoardFile): Rect | undefined {
  const rects: Rect[] = [
    ...file.blocks.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    ...file.strokes.filter((s) => s.points.length > 0).map((s) => pointsBounds(s.points)),
  ];
  for (const c of file.connectors) {
    for (const end of [c.from, c.to]) {
      if (!isBlockEnd(end)) {
        rects.push({ x: end.x, y: end.y, w: 0, h: 0 });
      }
    }
  }
  return unionRects(rects);
}

/**
 * Writes validated clipboard content into the board, centred on `at`, in one transaction:
 * new ids everywhere (connector ends and parent links remapped), stacked above everything in
 * their original order. File blocks are kept only when the content comes from `targetBoard`
 * itself - a file id of another board gives no access here (S4.4); the server would refuse it
 * anyway, so the source id in the envelope is a convenience, not a control.
 */
export function pasteClipboard(
  board: BoardDoc,
  envelope: ClipboardEnvelope,
  options: { at: Point; targetBoard: string | null },
): PasteResult {
  const sameBoard =
    options.targetBoard !== null && envelope.sourceBoard === options.targetBoard.toLowerCase();
  const source = envelope.content;
  const files = sameBoard ? [] : source.blocks.filter((b) => b.type === FILE_TYPE);
  const dropped = new Set(files.map((b) => b.id));
  const blocks = source.blocks.filter((b) => !dropped.has(b.id));
  const connectors = source.connectors.filter(
    (c) => ![c.from, c.to].some((e) => isBlockEnd(e) && dropped.has(e.block)),
  );
  const kept: BoardFile = { ...source, blocks, connectors };
  const bounds = contentBounds(kept);
  if (!bounds) {
    return { ids: [], topLevel: [], droppedFiles: files.length };
  }
  const dx = options.at.x - (bounds.x + bounds.w / 2);
  const dy = options.at.y - (bounds.y + bounds.h / 2);
  const ids = new Map<string, string>();
  for (const b of blocks) {
    ids.set(b.id, crypto.randomUUID());
  }
  const newId = (id: string): string => ids.get(id) as string;
  const remapEnd = (end: ConnectorEnd): ConnectorEnd =>
    isBlockEnd(end)
      ? { block: newId(end.block), anchor: end.anchor }
      : { x: end.x + dx, y: end.y + dy };
  let z = board.maxZ();
  const outBlocks: FileBlock[] = [...blocks]
    .sort((a, b) => a.z - b.z)
    .map((b) => ({
      ...b,
      id: newId(b.id),
      x: b.x + dx,
      y: b.y + dy,
      z: ++z,
      parent: b.parent !== null && ids.has(b.parent) ? newId(b.parent) : null,
    }));
  const outConnectors: FileConnector[] = connectors.map((c) => ({
    ...c,
    id: crypto.randomUUID(),
    from: remapEnd(c.from),
    to: remapEnd(c.to),
  }));
  const outStrokes: FileStroke[] = kept.strokes.map((s) => ({
    ...s,
    id: crypto.randomUUID(),
    points: s.points.map((v, i) => (i % 3 === 0 ? v + dx : i % 3 === 1 ? v + dy : v)),
  }));
  writeBoardFile(board, {
    ...kept,
    blocks: outBlocks,
    connectors: outConnectors,
    strokes: outStrokes,
  });
  return {
    ids: [
      ...outBlocks.map((b) => b.id),
      ...outConnectors.map((c) => c.id),
      ...outStrokes.map((s) => s.id),
    ],
    topLevel: outBlocks.filter((b) => b.parent === null).map((b) => b.id),
    droppedFiles: files.length,
  };
}
