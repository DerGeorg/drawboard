import { EstimationItemRef, EstimationItemRefKind, PokerDeck } from '@apps/drawboard-api';
import {
  KANBAN_ID,
  KANBAN_TYPE,
  KanbanModel,
  STORY_ID,
  STORY_TYPE,
  StoryModel,
  isValidEstimate,
  readStory,
  type BoardDoc,
} from '@apps/drawboard-engine';
import type { BoardEngine } from '../../../../../board-engine/engine';

/** Limits of the contract (E16): cards per session, title length. */
export const MAX_ITEMS = 50;
export const MAX_TITLE = 200;
/** Kanban `points` are whole numbers 0..999 (E21). */
const KANBAN_POINTS = /^(0|[1-9]\d{0,2})$/;
/** What the contract refuses in titles and reasons (E12): Cc, Cf, U+2028, U+2029. */
const NOT_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const NOT_TEXT_ALL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A card of the board that can go into a session. */
export interface ItemCandidate {
  readonly key: string;
  readonly ref: EstimationItemRef;
  /** The title as it will be sent: one line, plain text, at most 200 characters. */
  readonly title: string;
  /** The kanban the card sits on (its title), absent for story cards. */
  readonly group?: string;
}

/** What a card of a session looks like in the document right now (E20: read live by ref). */
export interface LiveItem {
  readonly title: string;
  readonly description: string;
  /** The value the card carries now (story or kanban `estimate`), or null. */
  readonly estimate: string | null;
  /** Kanban only: the story points of the card now. */
  readonly points?: number | null;
}

/** Why a decided value cannot be written into its card (E21). */
export type WriteRefusal = 'missing' | 'value';

export type WriteCheck =
  | { readonly ok: true; readonly live: LiveItem }
  | { readonly ok: false; readonly reason: WriteRefusal; readonly live?: LiveItem };

/** One key per ref: the server refuses the same ref twice in one session. */
export function refKey(ref: EstimationItemRef): string {
  return ref.kind === EstimationItemRefKind.KANBAN_CARD
    ? `${ref.blockId}/${ref.cardId ?? ''}`
    : ref.blockId;
}

/**
 * A title the contract accepts (E12): NFC, one line, no control or format characters, trimmed,
 * at most 200 characters; `fallback` when nothing is left.
 */
export function cleanTitle(text: string, fallback: string): string {
  const line = text.normalize('NFC').replace(NOT_TEXT_ALL, ' ').replace(/\s+/gu, ' ').trim();
  return Array.from(line).slice(0, MAX_TITLE).join('').trim() || fallback;
}

/** Whether a typed title or reason is one line of plain text (E12). */
export function isPlainLine(text: string): boolean {
  return !NOT_TEXT.test(text);
}

function kanbanOf(board: BoardDoc, blockId: string): KanbanModel | undefined {
  return board.getBlock(blockId)?.type === KANBAN_TYPE
    ? new KanbanModel(board, blockId)
    : undefined;
}

/**
 * Every card of the board that can be estimated, top to bottom: story cards and the cards of
 * kanban boards (with lowercase UUID ids, as the contract wants them).
 */
export function candidatesOf(board: BoardDoc): ItemCandidate[] {
  const blocks = board
    .blocks()
    .filter((b) => (b.type === STORY_TYPE || b.type === KANBAN_TYPE) && STORY_ID.test(b.id))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const out: ItemCandidate[] = [];
  for (const block of blocks) {
    if (block.type === STORY_TYPE) {
      const ref = { kind: EstimationItemRefKind.STORY, blockId: block.id };
      out.push({
        key: refKey(ref),
        ref,
        title: cleanTitle(readStory(board, block.id).title, 'Untitled story'),
      });
      continue;
    }
    const kanban = kanbanOf(board, block.id)?.read();
    for (const column of kanban?.columns ?? []) {
      for (const card of column.cards) {
        if (!KANBAN_ID.test(card.id)) {
          continue;
        }
        const ref = { kind: EstimationItemRefKind.KANBAN_CARD, blockId: block.id, cardId: card.id };
        out.push({
          key: refKey(ref),
          ref,
          title: cleanTitle(card.title, 'Untitled card'),
          group: cleanTitle(kanban?.title ?? '', 'Kanban'),
        });
      }
    }
  }
  return out;
}

/** The keys of the candidates the selection covers: story cards, and every card of a kanban. */
export function keysOfSelection(
  candidates: readonly ItemCandidate[],
  selected: readonly string[],
): string[] {
  const ids = new Set(selected);
  return candidates.filter((c) => ids.has(c.ref.blockId)).map((c) => c.key);
}

/**
 * The card a ref names, read live from the document - only when the block exists, has the type
 * the ref says and (kanban) holds that card (E21). Undefined otherwise.
 */
export function liveItem(board: BoardDoc, ref: EstimationItemRef): LiveItem | undefined {
  const block = board.getBlock(ref.blockId);
  if (ref.kind === EstimationItemRefKind.STORY) {
    if (block?.type !== STORY_TYPE) {
      return undefined;
    }
    const story = readStory(board, ref.blockId);
    return { title: story.title, description: story.description, estimate: story.estimate };
  }
  if (ref.kind !== EstimationItemRefKind.KANBAN_CARD || !ref.cardId) {
    return undefined;
  }
  const card = kanbanOf(board, ref.blockId)?.card(ref.cardId);
  return card
    ? {
        title: card.title,
        description: card.description,
        estimate: card.estimate,
        points: card.points,
      }
    : undefined;
}

/**
 * Whether `value` may be written into the card of `ref` (E21): the card must match its ref;
 * a story takes any valid estimate, a kanban card only a whole number 0..999 (its points).
 */
export function checkWrite(board: BoardDoc, ref: EstimationItemRef, value: string): WriteCheck {
  const live = liveItem(board, ref);
  if (!live) {
    return { ok: false, reason: 'missing' };
  }
  if (!isValidEstimate(value)) {
    return { ok: false, reason: 'value', live };
  }
  if (ref.kind === EstimationItemRefKind.KANBAN_CARD && !KANBAN_POINTS.test(value)) {
    return { ok: false, reason: 'value', live };
  }
  return { ok: true, live };
}

/**
 * Writes a decided value into its card as one ordinary editor update (E21): story `estimate`;
 * kanban `estimate` and `points`. Nothing else of the session enters the document (E20).
 */
export function writeDecision(
  board: BoardDoc,
  ref: EstimationItemRef,
  value: string,
  stopCapturing: () => void = () => undefined,
): boolean {
  if (!checkWrite(board, ref, value).ok) {
    return false;
  }
  if (ref.kind === EstimationItemRefKind.STORY) {
    return new StoryModel(board, ref.blockId, stopCapturing).setEstimate(value);
  }
  return new KanbanModel(board, ref.blockId, stopCapturing).updateCard(ref.cardId as string, {
    estimate: value,
    points: Number(value),
  });
}

/** Magic columns: the deck without `coffee` (`?` stays as the parking column). */
export function magicColumns(deck: PokerDeck): string[] {
  return (deck.values ?? []).filter((v) => v !== 'coffee');
}

/** How a deck value is shown: a cup for `coffee`. */
export function display(value: string): string {
  return value === 'coffee' ? '☕' : value;
}

/**
 * Rotation: how many cards each participant sees with `rounds` rounds - every round deals the
 * cards evenly, so `rounds × cards / participants`, rounded up.
 */
export function cardsPerPerson(rounds: number, items: number, seats: number): number {
  return seats < 1 || items < 1 ? 0 : Math.ceil((rounds * items) / seats);
}

/**
 * Rotation, the other way round: the rounds that let each of `seats` participants see about
 * `cards` cards, within 1..min(10, seats) (E7, E16).
 */
export function roundsFor(cards: number, items: number, seats: number): number {
  const most = Math.max(1, Math.min(10, seats));
  if (items < 1 || seats < 1 || !Number.isFinite(cards)) {
    return 1;
  }
  return Math.min(most, Math.max(1, Math.round((cards * seats) / items)));
}

/** Shows the block of a ref on the canvas: selects it and glides there. False when it is gone. */
export function focusRef(engine: BoardEngine, ref: EstimationItemRef): boolean {
  const block = engine.board.getBlock(ref.blockId);
  if (!block) {
    return false;
  }
  engine.selection.set([block.id]);
  engine.glideTo({ x: block.x + block.w / 2, y: block.y + block.h / 2 }, engine.camera.zoom);
  return true;
}
