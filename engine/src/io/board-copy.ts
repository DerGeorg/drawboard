import { FRAME_MAX_DEPTH, FRAME_TYPE } from '../model/frames.js';
import { BoardFile, ImportError, parseBoardFile } from './board-file.js';

export interface CopyRules {
  /** Block types of the plugins enabled on this instance; their props go through `pluginProps`. */
  pluginTypes?: ReadonlySet<string>;
  /** Types left out on purpose (e.g. "file" when the user copies without files); not counted. */
  omitTypes?: ReadonlySet<string>;
}

export interface CopyResult {
  file: BoardFile;
  /** Blocks that were left out because their type is unknown or disabled, or their props are invalid. */
  skipped: number;
}

/** Does the block's parent link hold up: an existing frame, no cycle, not nested too deep? */
function parentFits(
  block: Record<string, unknown>,
  byId: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
  let depth = block['type'] === FRAME_TYPE ? 1 : 0;
  const seen = new Set([block['id']]);
  let parent = byId.get(String(block['parent']));
  while (parent) {
    if (parent['type'] !== FRAME_TYPE || seen.has(parent['id'])) {
      return false;
    }
    seen.add(parent['id']);
    depth++;
    if (depth > FRAME_MAX_DEPTH) {
      return false;
    }
    const next = parent['parent'];
    if (next === null || next === undefined) {
      return true;
    }
    const nextBlock = byId.get(String(next));
    if (!nextBlock) {
      return false;
    }
    parent = nextBlock;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A template (or any board read from a live document) as import content: the same validation
 * as a `.drawboard` import or a paste (architecture 3.12, S5.5/S5.6). Every block is checked on
 * its own - unknown or disabled types, invalid props - and one that fails is LEFT OUT and counted,
 * together with the connectors attached to it; children of a left-out frame become top-level.
 * Structure a peer can write straight into the document is repaired and counted: a parent link
 * that is missing, no frame, in a cycle or too deep is cut (the block becomes top-level), and a
 * connector with an end at a missing block is left out. What remains goes through
 * `parseBoardFile` as a whole, so nothing unvalidated is ever written (only a wrong schema
 * version or duplicate ids still refuse the copy with an ImportError). Poker round
 * ids and plugin storage are not part of a board file and never travel along.
 */
export function importableCopy(file: BoardFile, rules: CopyRules = {}): CopyResult {
  const options = { pluginTypes: rules.pluginTypes };
  // plain JSON: whatever a live document handed over loses everything but data
  const raw = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
  const blocks = Array.isArray(raw['blocks']) ? (raw['blocks'] as unknown[]) : [];
  const removed = new Set<string>();
  let skipped = 0;
  const kept = blocks.filter((b) => {
    if (!isRecord(b)) {
      skipped++;
      return false;
    }
    let drop = false;
    let count = true;
    if (typeof b['type'] === 'string' && rules.omitTypes?.has(b['type'])) {
      drop = true;
      count = false;
    } else {
      try {
        // alone: a parent link is checked in the whole file below
        parseBoardFile(
          { schemaVersion: raw['schemaVersion'], blocks: [{ ...b, parent: null }] },
          options,
        );
      } catch (error) {
        if (!(error instanceof ImportError) || error.message.includes('board format version')) {
          throw error;
        }
        drop = true;
      }
    }
    if (drop) {
      skipped += count ? 1 : 0;
      if (typeof b['id'] === 'string') {
        removed.add(b['id']);
      }
    }
    return !drop;
  });
  const isRemoved = (id: unknown): boolean => typeof id === 'string' && removed.has(id);
  const endBlock = (end: unknown): unknown => (isRecord(end) ? end['block'] : undefined);

  // parent links: a peer can write anything into the document, so a link that is missing, no
  // frame, part of a cycle or too deep is cut (the block becomes top-level) instead of refusing
  const parents = new Map<string, Record<string, unknown>>();
  const fixed = kept.map((b) => {
    const block = b as Record<string, unknown>;
    const copy = { ...block };
    if (typeof copy['id'] === 'string') {
      parents.set(copy['id'], copy);
    }
    return copy;
  });
  for (const block of fixed) {
    if (isRemoved(block['parent'])) {
      block['parent'] = null; // a consequence of a block left out, not counted again
    }
  }
  for (const block of fixed) {
    const parent = block['parent'];
    if (parent !== null && parent !== undefined && !parentFits(block, parents)) {
      block['parent'] = null;
      skipped++;
    }
  }

  // connectors: both ends must be blocks that are still there
  const connectors = Array.isArray(raw['connectors']) ? (raw['connectors'] as unknown[]) : [];
  const keptConnectors = connectors.filter((c) => {
    if (!isRecord(c)) {
      return true; // the shape check of parseBoardFile decides
    }
    const ends = [endBlock(c['from']), endBlock(c['to'])].filter((e) => e !== undefined);
    if (ends.some(isRemoved)) {
      return false;
    }
    if (ends.some((e) => typeof e !== 'string' || !parents.has(e))) {
      skipped++;
      return false;
    }
    return true;
  });
  const content = { ...raw, blocks: fixed, connectors: keptConnectors };
  return { file: parseBoardFile(content, options), skipped };
}
