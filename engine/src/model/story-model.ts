import * as Y from 'yjs';

import { BoardDoc } from './board-doc.js';
import { applyTextDiff } from '../text/text-diff.js';

export const STORY_TYPE = 'core.story';

/** Limits of one story card: for what this client writes and for `.drawboard` imports (S5.5). */
export const STORY_LIMITS = {
  maxTitle: 200,
  maxDescription: 10_000,
  maxCriteria: 50,
  maxCriterion: 500,
  maxEstimate: 8,
} as const;

/**
 * An estimate is one value of a planning poker deck (`PokerDeck.values` of the contract):
 * 1-8 characters, no leading or trailing whitespace, no line break, no control or format
 * character.
 */
const ESTIMATE = /^\S(.{0,6}\S)?$/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

export function isValidEstimate(value: unknown): value is string {
  return typeof value === 'string' && ESTIMATE.test(value) && !CONTROL_OR_FORMAT.test(value);
}

/** Ids of criteria and of the story card itself: lowercase UUIDs. */
export const STORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
}

export interface StoryState {
  readonly title: string;
  readonly description: string;
  readonly criteria: readonly Criterion[];
  /** The agreed estimate (a deck value), or null. */
  readonly estimate: string | null;
  /**
   * Id of the planning poker round that runs on this card, an untrusted hint (any editor can
   * write it): the app binds a round to the card only when the server's `round.storyBlockId`
   * is this card's id.
   */
  readonly pokerRoundId: string | null;
}

/** The `board.json` form of a story card's props (the title is the block's text). */
export interface StoryFileProps {
  description: string;
  criteria: { id: string; text: string; done: boolean }[];
  estimate: string | null;
}

/*
 * Y.Doc schema (architecture 3.10):
 *
 *   block.text: Y.Text              the title (≤ 200 characters)
 *   props: Y.Map
 *     description   Y.Text          ≤ 10 000 characters, edited character by character
 *     criteria      Y.Array<Y.Map { id: string, text: string, done: boolean }>   ≤ 50
 *     estimate      string | null   a deck value
 *     pokerRoundId  string | null   a round id (an id only - never a vote, S7.6)
 *
 * Title and description are Y.Texts, so two people typing at once merge; a criterion is a map,
 * so ticking it off and rewording it at the same time both survive.
 */

type YMap = Y.Map<unknown>;

function propsOf(board: BoardDoc, blockId: string): YMap | undefined {
  const props = board.blocksMap.get(blockId)?.get('props');
  return props instanceof Y.Map ? (props as YMap) : undefined;
}

/** Reads a `criteria` array defensively; shared with the kanban cards that carry story details. */
export function readCriteria(v: unknown): Criterion[] {
  if (!(v instanceof Y.Array)) {
    return [];
  }
  const seen = new Set<string>();
  const out: Criterion[] = [];
  for (const item of (v as Y.Array<unknown>).toArray()) {
    if (out.length >= STORY_LIMITS.maxCriteria) {
      break;
    }
    if (!(item instanceof Y.Map)) {
      continue;
    }
    const m = item as YMap;
    const id = m.get('id');
    if (typeof id !== 'string' || !STORY_ID.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const text = m.get('text');
    out.push({
      id,
      text: typeof text === 'string' ? text.slice(0, STORY_LIMITS.maxCriterion) : '',
      done: m.get('done') === true,
    });
  }
  return out;
}

/** Reads a story card defensively (any editor can write anything into the document). */
export function readStory(board: BoardDoc, blockId: string): StoryState {
  const props = propsOf(board, blockId);
  const description = props?.get('description');
  const estimate = props?.get('estimate');
  const round = props?.get('pokerRoundId');
  return {
    title: board.textOf(blockId).slice(0, STORY_LIMITS.maxTitle),
    description:
      description instanceof Y.Text
        ? description.toString().slice(0, STORY_LIMITS.maxDescription)
        : '',
    criteria: readCriteria(props?.get('criteria')),
    estimate: isValidEstimate(estimate) ? estimate : null,
    pokerRoundId: typeof round === 'string' && STORY_ID.test(round) ? round : null,
  };
}

/** A new criterion map (`id`, `text`, `done`) for a Y.Array of criteria. */
export function criterionMap(c: { id: string; text: string; done: boolean }): YMap {
  const m = new Y.Map<unknown>();
  m.set('id', c.id);
  m.set('text', c.text);
  m.set('done', c.done);
  return m;
}

/** The props of a new story card (its title goes into the block's text). */
export function newStoryProps(): Record<string, unknown> {
  return {
    description: new Y.Text(),
    criteria: new Y.Array<unknown>(),
    estimate: null,
    pokerRoundId: null,
  };
}

/** Validated `board.json` props → values for a new props map. A round never comes along. */
export function storyPropsToY(file: StoryFileProps): Record<string, unknown> {
  const description = new Y.Text();
  description.insert(0, file.description);
  const criteria = new Y.Array<unknown>();
  criteria.push(file.criteria.map(criterionMap));
  return { description, criteria, estimate: file.estimate, pokerRoundId: null };
}

/** A story card's props → its `board.json` form (no round id: it belongs to this board only). */
export function storyPropsToFile(board: BoardDoc, blockId: string): StoryFileProps {
  const s = readStory(board, blockId);
  return {
    description: s.description,
    criteria: s.criteria.map((c) => ({ ...c })),
    estimate: s.estimate,
  };
}

/**
 * The edits of one story card, each one transaction with the board's local origin (undo).
 * Typing in title and description becomes the smallest Y.Text edit, so concurrent typing
 * merges; discrete edits (criteria, estimate) are undo steps of their own.
 */
export class StoryModel {
  constructor(
    private readonly board: BoardDoc,
    readonly blockId: string,
    private readonly stopCapturing: () => void = () => undefined,
  ) {}

  read(): StoryState {
    return readStory(this.board, this.blockId);
  }

  setTitle(title: string): void {
    const text = this.board.getText(this.blockId);
    if (text) {
      applyTextDiff(this.board, text, title.slice(0, STORY_LIMITS.maxTitle));
    }
  }

  setDescription(description: string): void {
    const props = propsOf(this.board, this.blockId);
    if (!props) {
      return;
    }
    let text = props.get('description');
    if (!(text instanceof Y.Text)) {
      text = new Y.Text();
      this.board.transact(() => props.set('description', text));
    }
    applyTextDiff(this.board, text as Y.Text, description.slice(0, STORY_LIMITS.maxDescription));
  }

  addCriterion(text: string): string | undefined {
    if (this.read().criteria.length >= STORY_LIMITS.maxCriteria) {
      return undefined;
    }
    const id = crypto.randomUUID();
    this.edit((props) =>
      this.criteria(props).push([
        criterionMap({ id, text: text.slice(0, STORY_LIMITS.maxCriterion), done: false }),
      ]),
    );
    return id;
  }

  updateCriterion(id: string, patch: { text?: string; done?: boolean }): void {
    const m = this.criterionMap(id);
    if (!m) {
      return;
    }
    this.edit(() => {
      if (patch.text !== undefined && m.get('text') !== patch.text) {
        m.set('text', patch.text.slice(0, STORY_LIMITS.maxCriterion));
      }
      if (patch.done !== undefined && m.get('done') !== patch.done) {
        m.set('done', patch.done);
      }
    });
  }

  deleteCriterion(id: string): void {
    this.edit((props) => {
      const list = this.criteria(props);
      const index = list.toArray().findIndex((m) => m instanceof Y.Map && m.get('id') === id);
      if (index >= 0) {
        list.delete(index, 1);
      }
    });
  }

  /** Sets (or clears with null) the estimate; an invalid value is not written. */
  setEstimate(estimate: string | null): boolean {
    if (estimate !== null && !isValidEstimate(estimate)) {
      return false;
    }
    this.edit((props) => props.get('estimate') !== estimate && props.set('estimate', estimate));
    return true;
  }

  /** Marks the round that runs on this card (an id only, never a vote - S7.6). */
  setPokerRound(roundId: string | null): void {
    if (roundId !== null && !STORY_ID.test(roundId)) {
      return;
    }
    this.edit(
      (props) => props.get('pokerRoundId') !== roundId && props.set('pokerRoundId', roundId),
    );
  }

  /**
   * The end of a round (S7.6 refined): writes the chosen estimate and clears `pokerRoundId`,
   * in one transaction - an ordinary editor update. Only when the card still points to that
   * round, so a late writer never clears a newer round.
   */
  finishRound(roundId: string, estimate: string | null): boolean {
    if (estimate !== null && !isValidEstimate(estimate)) {
      return false;
    }
    let done = false;
    this.edit((props) => {
      if (props.get('pokerRoundId') === roundId) {
        if (estimate !== null) {
          props.set('estimate', estimate);
        }
        props.set('pokerRoundId', null);
        done = true;
      }
    });
    return done;
  }

  private criteria(props: YMap): Y.Array<unknown> {
    const existing = props.get('criteria');
    if (existing instanceof Y.Array) {
      return existing as Y.Array<unknown>;
    }
    const list = new Y.Array<unknown>();
    props.set('criteria', list);
    return list;
  }

  private criterionMap(id: string): YMap | undefined {
    const list = propsOf(this.board, this.blockId)?.get('criteria');
    if (!(list instanceof Y.Array)) {
      return undefined;
    }
    const m = (list as Y.Array<unknown>)
      .toArray()
      .find((item) => item instanceof Y.Map && item.get('id') === id);
    return m as YMap | undefined;
  }

  private edit(fn: (props: YMap) => void): void {
    const props = propsOf(this.board, this.blockId);
    if (!props) {
      return;
    }
    this.stopCapturing();
    this.board.transact(() => fn(props));
    this.stopCapturing();
  }
}
