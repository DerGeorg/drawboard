import * as Y from 'yjs';

import { EMOJI_TYPE } from '../blocks/emoji';
import {
  KANBAN_ID,
  KANBAN_LIMITS,
  KANBAN_TYPE,
  KanbanFileCard,
  KanbanFileColumn,
  KanbanFileProps,
  isKanbanLabel,
  isValidDueDate,
  kanbanPropsToFile,
  kanbanPropsToY,
} from '../blocks/kanban-model';
import {
  STORY_ID,
  STORY_LIMITS,
  STORY_TYPE,
  StoryFileProps,
  isValidEstimate,
  storyPropsToFile,
  storyPropsToY,
} from '../blocks/story-model';
import { BoardDoc } from '../model/board-doc';
import { FRAME_MAX_DEPTH, FRAME_TITLE_MAX, FRAME_TYPE } from '../model/frames';
import { normalizeTables, parseCellProps, parseTableProps } from '../model/tables';
import {
  Anchor,
  BlockData,
  ConnectorData,
  ConnectorEnd,
  MAX_TEXT_LENGTH,
  Props,
  SCHEMA_VERSION,
  StrokeData,
} from '../model/types';
import { LIMITS as PLUGIN_LIMITS, isPlainJson, jsonBytes, withinBound } from '../plugins/protocol';
import { EMOJI_FALLBACK, MAX_EMOJI_LENGTH, isValidEmoji } from '../util/emoji';

/**
 * `board.json`: the readable JSON form of a board document, inside a `.drawboard` archive, as a
 * stand-alone file and (deflated) in a data URL. It is data from OUTSIDE (a stranger's file or
 * link): `parseBoardFile` validates every field (architecture S5.5/S5.6) and throws an
 * ImportError for anything it does not know - nothing unvalidated reaches the document.
 */
export interface BoardFile {
  schemaVersion: number;
  title: string;
  blocks: FileBlock[];
  connectors: FileConnector[];
  strokes: FileStroke[];
}

export interface FileBlock {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  parent: string | null;
  locked: boolean;
  props: Props;
  text?: string;
}

export interface FileConnector {
  id: string;
  from: ConnectorEnd;
  to: ConnectorEnd;
  style: { color: string; width: number; arrow: boolean; dashed: boolean };
  label: string;
}

export interface FileStroke {
  id: string;
  /** Flat `[x, y, pressure, ...]`. */
  points: number[];
  style: { color: string; size: number };
}

/** The limits of S5.5 that apply to the document itself. */
export const LIMITS = {
  maxBlocks: 20_000,
  maxConnectors: 20_000,
  maxStrokes: 20_000,
  /** Numbers (3 per point) of one stroke. */
  maxStrokeNumbers: 150_000,
  maxTitleLength: 200,
  maxLabelLength: 1_000,
  /** Coordinates beyond this are not a drawing but an attack on the renderer. */
  maxCoordinate: 10_000_000,
  maxSize: 1_000_000,
} as const;

/**
 * Why a file or link cannot be imported: the message is for the user. `reason` is the bare
 * finding ("block 3 has the unknown type ...") for callers that word the message themselves
 * (the clipboard).
 */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly reason: string = message,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * How strict one parse is. The defaults are the `.drawboard` import (S5.5); the clipboard
 * passes smaller limits and the block types of the plugins enabled on the target board.
 */
export interface ParseOptions {
  maxBlocks?: number;
  maxConnectors?: number;
  maxStrokes?: number;
  /**
   * Block types of plugins that are enabled on the board the content goes to. Their props are
   * checked by the plugin protocol's own rules for props (plain JSON, no `__proto__`,
   * `constructor`, `prototype` keys, at most 64 KiB - exactly what `block.setProps` accepts);
   * every other type outside the built-ins is refused. Empty for file import (README TODO).
   */
  pluginTypes?: ReadonlySet<string>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^#[0-9a-f]{3,8}$/i;
const ANCHORS: readonly Anchor[] = ['auto', 'top', 'right', 'bottom', 'left'];
const SHAPE_KINDS = ['rect', 'ellipse', 'diamond'];
const NO_TYPES: ReadonlySet<string> = new Set();

function fail(what: string): never {
  throw new ImportError(`The file is not a valid Drawboard board: ${what}.`, what);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown, what: string, max: number = LIMITS.maxCoordinate): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) {
    return fail(`${what} must be a finite number`);
  }
  return v;
}

function positive(v: unknown, what: string): number {
  const n = finite(v, what, LIMITS.maxSize);
  if (n <= 0) {
    return fail(`${what} must be greater than 0`);
  }
  return n;
}

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !ID.test(v)) {
    return fail(`${what} is not a valid id`);
  }
  return v;
}

function hex(v: unknown, what: string): string {
  if (typeof v !== 'string' || !HEX.test(v)) {
    return fail(`${what} must be a hex colour`);
  }
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') {
    return fail(`${what} must be true or false`);
  }
  return v;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) {
    return fail(`${what} must be text of at most ${max} characters`);
  }
  return v;
}

/** Per block type: which props exist and what they may hold. Unknown types are refused. */
const PROPS: Readonly<Record<string, (props: Record<string, unknown>) => Props>> = {
  'core.sticky': (p) =>
    p['color'] === undefined ? {} : { color: hex(p['color'], 'a sticky colour') },
  'core.text': (p) => ({
    ...(p['color'] === undefined ? {} : { color: hex(p['color'], 'a text colour') }),
    ...(p['fontSize'] === undefined ? {} : { fontSize: fontSize(p['fontSize']) }),
  }),
  'core.shape': (p) => ({
    ...(p['kind'] === undefined ? {} : { kind: shapeKind(p['kind']) }),
    ...(p['fill'] === undefined
      ? {}
      : { fill: p['fill'] === 'none' ? 'none' : hex(p['fill'], 'a shape fill') }),
    ...(p['stroke'] === undefined ? {} : { stroke: hex(p['stroke'], 'a shape outline colour') }),
    ...(p['strokeWidth'] === undefined
      ? {}
      : { strokeWidth: boundedNumber(p['strokeWidth'], 0, 64, 'a stroke width') }),
  }),
  // one emoji (or a few): text only, nothing else (S5.5, architecture 3.13)
  [EMOJI_TYPE]: (p) => ({ emoji: emoji(p['emoji']) }),
  // a reference only (S4.4): the file itself is not in the archive yet, so on another board it
  // shows "not available" - the id is all that is kept, never a URL
  'core.file': (p) => ({ fileId: fileId(p['fileId']) }),
  // the source is the block's text (rendered by the strict, sanitising renderer, S5.1)
  'core.mermaid': () => ({}),
  // the title is the block's text
  // table and cell are checked here for their shape and below for the structure (normalizeTables):
  // a broken table is imported as plain frames, not refused
  [FRAME_TYPE]: (p) => {
    const table = parseTableProps(p['table']);
    const cell = parseCellProps(p['cell']);
    return {
      ...(p['fill'] === undefined
        ? {}
        : { fill: p['fill'] === 'transparent' ? 'transparent' : hex(p['fill'], 'a frame fill') }),
      ...(table ? { table } : {}),
      ...(cell ? { cell } : {}),
    };
  },
  [KANBAN_TYPE]: (p) => kanbanProps(p) as unknown as Props,
  // the title is the block's text; a planning poker round id never comes along (it belongs to
  // the board it was started on)
  [STORY_TYPE]: (p) => storyProps(p) as unknown as Props,
};

/**
 * Block types whose props hold nested Yjs types (one Y.Map per column and card): how their
 * validated file props become Yjs values, and how the props map becomes file props again.
 */
const STRUCTURED: ReadonlyMap<
  string,
  { toY(props: Props): Props; toFile(board: BoardDoc, id: string): Props }
> = new Map([
  [
    KANBAN_TYPE,
    {
      toY: (p: Props) => kanbanPropsToY(p as unknown as KanbanFileProps),
      toFile: (board: BoardDoc, id: string) =>
        kanbanPropsToFile(propsMap(board, id)) as unknown as Props,
    },
  ],
  [
    STORY_TYPE,
    {
      toY: (p: Props) => storyPropsToY(p as unknown as StoryFileProps),
      toFile: (board: BoardDoc, id: string) => storyPropsToFile(board, id) as unknown as Props,
    },
  ],
]);

function storyProps(p: Record<string, unknown>): StoryFileProps {
  const criteria = list(p['criteria'], 'acceptance criteria', STORY_LIMITS.maxCriteria).map(
    (raw, i) => {
      if (!isRecord(raw)) {
        return fail(`acceptance criterion ${i} is not an object`);
      }
      const id = raw['id'];
      if (typeof id !== 'string' || !STORY_ID.test(id)) {
        return fail(`acceptance criterion ${i} has no valid id`);
      }
      return {
        id,
        text: text(raw['text'] ?? '', `acceptance criterion ${i}`, STORY_LIMITS.maxCriterion),
        done: raw['done'] === undefined ? false : bool(raw['done'], `done of criterion ${i}`),
      };
    },
  );
  unique(criteria, 'acceptance criteria');
  const estimate = p['estimate'] ?? null;
  if (estimate !== null && !isValidEstimate(estimate)) {
    return fail('a story estimate must be a short value like 5 or XL');
  }
  return {
    description: text(p['description'] ?? '', 'a story description', STORY_LIMITS.maxDescription),
    criteria,
    estimate,
  };
}

function kanbanId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !KANBAN_ID.test(v)) {
    return fail(`${what} is not a valid id`);
  }
  return v;
}

function kanbanProps(p: Record<string, unknown>): KanbanFileProps {
  const columns = list(p['columns'], 'kanban columns', KANBAN_LIMITS.maxColumns).map(
    (raw, i): KanbanFileColumn => {
      if (!isRecord(raw)) {
        return fail(`kanban column ${i} is not an object`);
      }
      return {
        id: kanbanId(raw['id'], `kanban column ${i}`),
        title: text(
          raw['title'] ?? '',
          `the title of kanban column ${i}`,
          KANBAN_LIMITS.maxColumnTitle,
        ),
        order: finite(raw['order'] ?? i, `the order of kanban column ${i}`),
      };
    },
  );
  unique(columns, 'kanban columns');
  const columnIds = new Set(columns.map((c) => c.id));
  const cards = list(p['cards'], 'kanban cards', KANBAN_LIMITS.maxCards).map(
    (raw, i): KanbanFileCard => {
      if (!isRecord(raw)) {
        return fail(`kanban card ${i} is not an object`);
      }
      const column = kanbanId(raw['column'], `the column of kanban card ${i}`);
      if (!columnIds.has(column)) {
        return fail(`kanban card ${i} is in a column that does not exist`);
      }
      const labels = list(raw['labels'], `labels of kanban card ${i}`, 20).map((l) => {
        if (!isKanbanLabel(l)) {
          return fail(`kanban card ${i} has an unknown label`);
        }
        return l;
      });
      const assignee = raw['assignee'] ?? null;
      const due = raw['due'] ?? null;
      const points = raw['points'] ?? null;
      if (due !== null && !isValidDueDate(due)) {
        return fail(`the due date of kanban card ${i} is not a date (YYYY-MM-DD)`);
      }
      return {
        id: kanbanId(raw['id'], `kanban card ${i}`),
        column,
        order: finite(raw['order'] ?? i, `the order of kanban card ${i}`),
        title: text(raw['title'] ?? '', `the title of kanban card ${i}`, KANBAN_LIMITS.maxTitle),
        assignee:
          assignee === null
            ? null
            : text(assignee, `the assignee of kanban card ${i}`, KANBAN_LIMITS.maxAssignee),
        due,
        labels: [...new Set(labels)],
        points:
          points === null
            ? null
            : boundedNumber(points, 0, KANBAN_LIMITS.maxPoints, `the points of kanban card ${i}`),
      };
    },
  );
  unique(cards, 'kanban cards');
  return {
    title: text(p['title'] ?? '', 'the title of a kanban', KANBAN_LIMITS.maxTitle),
    columns,
    cards,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileId(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) {
    return fail('a file block must reference a file id');
  }
  return v.toLowerCase();
}

function emoji(v: unknown): string {
  if (!isValidEmoji(v)) {
    return fail(`an emoji must be 1 to ${MAX_EMOJI_LENGTH} characters of emoji and nothing else`);
  }
  return v;
}

function fontSize(v: unknown): number {
  return boundedNumber(v, 4, 512, 'a font size');
}

function boundedNumber(v: unknown, min: number, max: number, what: string): number {
  const n = finite(v, what, max);
  if (n < min) {
    return fail(`${what} must be at least ${min}`);
  }
  return n;
}

function shapeKind(v: unknown): string {
  if (typeof v !== 'string' || !SHAPE_KINDS.includes(v)) {
    return fail('a shape kind must be rect, ellipse or diamond');
  }
  return v;
}

/** Props of a block of an enabled plugin: the rules of the plugin protocol (S3.7, S3.8). */
function pluginProps(p: Record<string, unknown>): Props {
  // the cheap bound first (it stops early on huge values), then the exact checks
  if (
    !withinBound(p, PLUGIN_LIMITS.propsBytes) ||
    !isPlainJson(p) ||
    jsonBytes(p) > PLUGIN_LIMITS.propsBytes
  ) {
    return fail('the props of a plugin block are not plain JSON of at most 64 KiB');
  }
  return structuredClone(p);
}

/** The props validator of a block type, or undefined if the type is not accepted here. */
function propsValidator(
  type: string,
  pluginTypes: ReadonlySet<string>,
): ((props: Record<string, unknown>) => Props) | undefined {
  // own keys only: "constructor" or "__proto__" must not resolve to something on Object.prototype
  if (Object.hasOwn(PROPS, type)) {
    return PROPS[type];
  }
  // never a core.* type through the plugin path (the built-ins are the only trusted types, S3.1)
  return pluginTypes.has(type) && !type.startsWith('core.') ? pluginProps : undefined;
}

/** True if blocks of this type can be imported or pasted at all (built-in or enabled plugin). */
export function acceptsBlockType(
  type: string,
  pluginTypes: ReadonlySet<string> = NO_TYPES,
): boolean {
  return propsValidator(type, pluginTypes) !== undefined;
}

function parseBlock(
  raw: unknown,
  index: number,
  pluginTypes: ReadonlySet<string> = NO_TYPES,
): FileBlock {
  if (!isRecord(raw)) {
    return fail(`block ${index} is not an object`);
  }
  const type = text(raw['type'], `the type of block ${index}`, 100);
  const validateProps = propsValidator(type, pluginTypes);
  if (!validateProps) {
    return fail(`block ${index} has the unknown type "${type.slice(0, 40)}"`);
  }
  const rawProps = raw['props'] ?? {};
  if (!isRecord(rawProps)) {
    return fail(`the props of block ${index} are not an object`);
  }
  const parent = raw['parent'] ?? null;
  const block: FileBlock = {
    id: id(raw['id'], `the id of block ${index}`),
    type,
    x: finite(raw['x'], `x of block ${index}`),
    y: finite(raw['y'], `y of block ${index}`),
    w: positive(raw['w'], `w of block ${index}`),
    h: positive(raw['h'], `h of block ${index}`),
    rotation: finite(raw['rotation'] ?? 0, `rotation of block ${index}`, 100_000),
    z: finite(raw['z'] ?? 0, `z of block ${index}`),
    parent: parent === null ? null : id(parent, `the parent of block ${index}`),
    locked: raw['locked'] === undefined ? false : bool(raw['locked'], `locked of block ${index}`),
    props: validateProps(rawProps),
  };
  // Plugin blocks have no Y.Text: text is for built-in types only.
  if (raw['text'] !== undefined && Object.hasOwn(PROPS, type)) {
    block.text = text(
      raw['text'],
      `the text of block ${index}`,
      type === STORY_TYPE
        ? STORY_LIMITS.maxTitle
        : type === FRAME_TYPE
          ? FRAME_TITLE_MAX
          : MAX_TEXT_LENGTH,
    );
  }
  return block;
}

function parseEnd(raw: unknown, what: string): ConnectorEnd {
  if (!isRecord(raw)) {
    return fail(`${what} is not an object`);
  }
  if (raw['block'] !== undefined) {
    const anchor = raw['anchor'];
    if (typeof anchor !== 'string' || !ANCHORS.includes(anchor as Anchor)) {
      return fail(`${what} has an unknown anchor`);
    }
    return { block: id(raw['block'], `the block of ${what}`), anchor: anchor as Anchor };
  }
  return { x: finite(raw['x'], `x of ${what}`), y: finite(raw['y'], `y of ${what}`) };
}

function parseConnector(raw: unknown, index: number): FileConnector {
  if (!isRecord(raw)) {
    return fail(`connector ${index} is not an object`);
  }
  const style = raw['style'] ?? {};
  if (!isRecord(style)) {
    return fail(`the style of connector ${index} is not an object`);
  }
  return {
    id: id(raw['id'], `the id of connector ${index}`),
    from: parseEnd(raw['from'], `the start of connector ${index}`),
    to: parseEnd(raw['to'], `the end of connector ${index}`),
    style: {
      color: style['color'] === undefined ? '#334155' : hex(style['color'], 'a connector colour'),
      width:
        style['width'] === undefined
          ? 2
          : boundedNumber(style['width'], 0.5, 64, 'a connector width'),
      arrow: style['arrow'] === undefined ? true : bool(style['arrow'], 'a connector arrow flag'),
      dashed:
        style['dashed'] === undefined ? false : bool(style['dashed'], 'a connector dashed flag'),
    },
    label:
      raw['label'] === undefined
        ? ''
        : text(raw['label'], `the label of connector ${index}`, LIMITS.maxLabelLength),
  };
}

function parseStroke(raw: unknown, index: number): FileStroke {
  if (!isRecord(raw)) {
    return fail(`stroke ${index} is not an object`);
  }
  const points = raw['points'];
  if (
    !Array.isArray(points) ||
    points.length % 3 !== 0 ||
    points.length > LIMITS.maxStrokeNumbers
  ) {
    return fail(`the points of stroke ${index} are not a list of x, y, pressure triples`);
  }
  const style = raw['style'] ?? {};
  if (!isRecord(style)) {
    return fail(`the style of stroke ${index} is not an object`);
  }
  return {
    id: id(raw['id'], `the id of stroke ${index}`),
    points: points.map((p) => finite(p, `a point of stroke ${index}`)),
    style: {
      color: style['color'] === undefined ? '#0f172a' : hex(style['color'], 'a stroke colour'),
      size:
        style['size'] === undefined ? 4 : boundedNumber(style['size'], 0.5, 256, 'a stroke size'),
    },
  };
}

function list(raw: unknown, what: string, max: number): unknown[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return fail(`${what} must be a list`);
  }
  if (raw.length > max) {
    return fail(`there are more than ${max} ${what}`);
  }
  return raw;
}

function unique(items: { id: string }[], what: string): void {
  if (new Set(items.map((i) => i.id)).size !== items.length) {
    fail(`${what} share an id`);
  }
}

/**
 * Parent links (frames, see model/frames.ts): the parent exists and is a frame, the links form
 * no cycle, and frames nest at most FRAME_MAX_DEPTH deep.
 */
function checkParents(blocks: readonly FileBlock[]): void {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const [i, block] of blocks.entries()) {
    if (block.parent === null) {
      continue;
    }
    const parent = byId.get(block.parent);
    if (!parent) {
      fail(`block ${i} has a parent that does not exist`);
    }
    if (parent.type !== FRAME_TYPE) {
      fail(`block ${i} has a parent that is not a frame`);
    }
    // count the frames above; a cycle never ends, so it passes the depth too
    let depth = block.type === FRAME_TYPE ? 1 : 0;
    const seen = new Set([block.id]);
    for (let p: FileBlock | undefined = parent; p; p = p.parent ? byId.get(p.parent) : undefined) {
      if (seen.has(p.id)) {
        fail(`the frames of block ${i} contain each other`);
      }
      seen.add(p.id);
      depth++;
      if (depth > FRAME_MAX_DEPTH) {
        fail(`block ${i} is nested more than ${FRAME_MAX_DEPTH} frames deep`);
      }
    }
  }
}

/** Validates parsed JSON; returns a clean copy that holds only what this version knows. */
export function parseBoardFile(json: unknown, options: ParseOptions = {}): BoardFile {
  if (!isRecord(json)) {
    return fail('the top level is not an object');
  }
  if (json['schemaVersion'] !== SCHEMA_VERSION) {
    throw new ImportError(
      `This file uses the board format version ${String(json['schemaVersion']).slice(0, 20)}, which this version of Drawboard cannot open.`,
    );
  }
  const file: BoardFile = {
    schemaVersion: SCHEMA_VERSION,
    title:
      json['title'] === undefined ? '' : text(json['title'], 'the title', LIMITS.maxTitleLength),
    blocks: list(json['blocks'], 'blocks', options.maxBlocks ?? LIMITS.maxBlocks).map((b, i) =>
      parseBlock(b, i, options.pluginTypes),
    ),
    connectors: list(
      json['connectors'],
      'connectors',
      options.maxConnectors ?? LIMITS.maxConnectors,
    ).map(parseConnector),
    strokes: list(json['strokes'], 'strokes', options.maxStrokes ?? LIMITS.maxStrokes).map(
      parseStroke,
    ),
  };
  unique(file.blocks, 'blocks');
  unique(file.connectors, 'connectors');
  unique(file.strokes, 'strokes');
  const blockIds = new Set(file.blocks.map((b) => b.id));
  checkParents(file.blocks);
  normalizeTables(file.blocks);
  for (const [i, connector] of file.connectors.entries()) {
    for (const end of [connector.from, connector.to]) {
      if ('block' in end && !blockIds.has(end.block)) {
        fail(`connector ${i} points to a block that does not exist`);
      }
    }
  }
  return file;
}

/** One block as file content (nested Yjs props flattened). */
export function blockToFile(board: BoardDoc, b: BlockData): FileBlock {
  // an emoji prop from a peer that is not an emoji leaves as the fallback, never as is: a file
  // we write must pass our own import
  const props =
    b.type === EMOJI_TYPE && !isValidEmoji(b.props['emoji'])
      ? { ...b.props, emoji: EMOJI_FALLBACK }
      : (STRUCTURED.get(b.type)?.toFile(board, b.id) ?? b.props);
  return {
    id: b.id,
    type: b.type,
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    rotation: b.rotation,
    z: b.z,
    parent: b.parent,
    locked: b.locked,
    props,
    ...(b.hasText ? { text: board.textOf(b.id) } : {}),
  };
}

export function connectorToFile(c: ConnectorData): FileConnector {
  return { id: c.id, from: c.from, to: c.to, style: c.style, label: c.label };
}

export function strokeToFile(s: StrokeData): FileStroke {
  return { id: s.id, points: s.points, style: s.style };
}

/** The document as `board.json` content. References only: no embedded files exist yet. */
export function boardToFile(board: BoardDoc, title: string): BoardFile {
  return {
    schemaVersion: board.schemaVersion,
    title: title.slice(0, LIMITS.maxTitleLength),
    blocks: board.blocks().map((b) => blockToFile(board, b)),
    connectors: board.connectors().map(connectorToFile),
    strokes: board.strokes().map(strokeToFile),
  };
}

function propsMap(board: BoardDoc, id: string): Y.Map<unknown> | undefined {
  const props = board.blocksMap.get(id)?.get('props');
  return props instanceof Y.Map ? (props as Y.Map<unknown>) : undefined;
}

/** Writes a VALIDATED file into an (empty) document in one transaction. */
export function writeBoardFile(board: BoardDoc, file: BoardFile): void {
  // belt and braces: a file that did not come through parseBoardFile never puts a foreign
  // string into an emoji prop
  for (const b of file.blocks) {
    if (b.type === EMOJI_TYPE && !isValidEmoji(b.props['emoji'])) {
      fail('an emoji block holds something that is not an emoji');
    }
  }
  board.transact(() => {
    for (const b of file.blocks) {
      const m = new Y.Map<unknown>();
      board.blocksMap.set(b.id, m);
      m.set('id', b.id);
      m.set('type', b.type);
      m.set('x', b.x);
      m.set('y', b.y);
      m.set('w', b.w);
      m.set('h', b.h);
      m.set('rotation', b.rotation);
      m.set('z', b.z);
      m.set('parent', b.parent);
      m.set('locked', b.locked);
      const props = new Y.Map<unknown>();
      m.set('props', props);
      const values = STRUCTURED.get(b.type)?.toY(b.props) ?? b.props;
      for (const [k, v] of Object.entries(values)) {
        props.set(k, v);
      }
      if (b.text !== undefined) {
        const t = new Y.Text();
        m.set('text', t);
        t.insert(0, b.text);
      }
    }
    for (const c of file.connectors) {
      const m = new Y.Map<unknown>();
      board.connectorsMap.set(c.id, m);
      m.set('id', c.id);
      m.set('from', c.from);
      m.set('to', c.to);
      m.set('style', c.style);
      m.set('label', c.label);
    }
    for (const s of file.strokes) {
      const m = new Y.Map<unknown>();
      board.strokesMap.set(s.id, m);
      m.set('id', s.id);
      m.set('points', s.points);
      m.set('style', s.style);
    }
  });
}

/**
 * Splits a validated file into pieces whose JSON stays below `maxBytes` (a single item may
 * exceed it). Writing a big board in one transaction would make one UPDATE frame over the 1 MiB
 * limit of the protocol; the pieces are written one after the other.
 */
export function splitBoardFile(file: BoardFile, maxBytes: number): BoardFile[] {
  const pieces: BoardFile[] = [];
  let current: BoardFile = { ...file, blocks: [], connectors: [], strokes: [] };
  let size = 0;
  const push = (): void => {
    if (current.blocks.length + current.connectors.length + current.strokes.length > 0) {
      pieces.push(current);
    }
    current = { ...file, blocks: [], connectors: [], strokes: [] };
    size = 0;
  };
  const add = <K extends 'blocks' | 'connectors' | 'strokes'>(
    key: K,
    item: BoardFile[K][number],
  ): void => {
    const bytes = JSON.stringify(item).length;
    if (size > 0 && size + bytes > maxBytes) {
      push();
    }
    (current[key] as unknown[]).push(item);
    size += bytes;
  };
  file.blocks.forEach((b) => add('blocks', b));
  file.connectors.forEach((c) => add('connectors', c));
  file.strokes.forEach((st) => add('strokes', st));
  push();
  return pieces;
}
