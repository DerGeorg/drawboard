import {
  EstimationItem,
  EstimationItemRef,
  EstimationMode,
  EstimationSeat,
  EstimationSession,
  EstimationSessionState,
  EstimationSessionSummary,
} from '@apps/drawboard-api';

import {
  KANBAN_TYPE,
  KanbanModel,
  newKanbanProps,
  STORY_TYPE,
  StoryModel,
  newStoryProps,
  BoardDoc,
} from '@apps/drawboard-engine';

export const SESSION_ID = '0192cccc-0000-7000-8000-000000000001';
export const ITEM_A = '0192cccc-0000-7000-8000-0000000000a1';
export const ITEM_B = '0192cccc-0000-7000-8000-0000000000b2';
export const SEAT_ME = '5e5e5e5e-0000-4000-8000-000000000001';
export const SEAT_BOB = '5e5e5e5e-0000-4000-8000-000000000002';
export const SEAT_GINA = '5e5e5e5e-0000-4000-8000-000000000003';
export const STORY_A = '11111111-1111-4111-8111-111111111111';
export const KANBAN_B = '22222222-2222-4222-8222-222222222222';
export const CARD_B = '33333333-3333-4333-8333-333333333333';

const FIBONACCI = ['0', '1', '2', '3', '5', '8', '13', '21', '?', 'coffee'];

export function aSeat(overrides: Partial<EstimationSeat> = {}): EstimationSeat {
  return {
    id: SEAT_ME,
    displayName: 'Alice Admin',
    guest: false,
    seated: true,
    done: false,
    ...overrides,
  };
}

export function anItem(overrides: Partial<EstimationItem> = {}): EstimationItem {
  return {
    id: ITEM_A,
    ref: { kind: 'STORY', blockId: STORY_A },
    title: 'Login',
    position: 0,
    mine: false,
    ...overrides,
  };
}

/** A session as getEstimationSession answers it: Rotation in LOBBY, Alice moderates and sits. */
export function aSession(overrides: Partial<EstimationSession> = {}): EstimationSession {
  return {
    id: SESSION_ID,
    mode: EstimationMode.ROTATION,
    title: 'Sprint 42',
    deck: { kind: 'FIBONACCI', values: FIBONACCI },
    anonymous: true,
    settings: { rounds: 2, roundSeconds: 120, advanceWhenDone: true },
    state: EstimationSessionState.LOBBY,
    round: 0,
    serverTime: '2026-11-19T10:00:00Z',
    moderatorId: 'id-alice',
    moderatorName: 'Alice Admin',
    createdAt: '2026-11-19T09:59:00Z',
    version: 1,
    seats: [
      aSeat(),
      aSeat({ id: SEAT_BOB, displayName: 'Bob Builder' }),
      aSeat({ id: SEAT_GINA, displayName: 'Gina', guest: true }),
    ],
    items: [
      anItem(),
      anItem({
        id: ITEM_B,
        ref: { kind: 'KANBAN_CARD', blockId: KANBAN_B, cardId: CARD_B },
        title: 'Checkout',
        position: 1,
      }),
    ],
    me: { seatId: SEAT_ME, seated: true, moderator: true },
    ...overrides,
  };
}

/** A Magic session; `state` defaults to PLACING with a deadline one minute after serverTime. */
export function aMagicSession(overrides: Partial<EstimationSession> = {}): EstimationSession {
  return aSession({
    mode: EstimationMode.MAGIC,
    settings: { placingSeconds: 60, movingSeconds: 120, markThreshold: 3 },
    state: EstimationSessionState.PLACING,
    phaseEndsAt: '2026-11-19T10:01:00Z',
    startedAt: '2026-11-19T10:00:00Z',
    ...overrides,
  });
}

export function aSummary(
  overrides: Partial<EstimationSessionSummary> = {},
): EstimationSessionSummary {
  return {
    id: SESSION_ID,
    mode: EstimationMode.ROTATION,
    title: 'Sprint 42',
    state: EstimationSessionState.LOBBY,
    round: 0,
    moderatorName: 'Alice Admin',
    createdAt: '2026-11-19T09:59:00Z',
    seatCount: 3,
    itemCount: 2,
    me: { seatId: SEAT_ME, seated: true, moderator: true },
    ...overrides,
  };
}

/** A board with one story card (top) and a kanban with one card (below it). */
export function aBoardWithCards(): {
  board: BoardDoc;
  storyId: string;
  kanbanId: string;
  cardId: string;
  storyRef: EstimationItemRef;
  cardRef: EstimationItemRef;
} {
  const board = new BoardDoc();
  const kanbanId = board.addBlock({
    type: KANBAN_TYPE,
    x: 0,
    y: 400,
    w: 600,
    h: 300,
    props: newKanbanProps('Sprint board'),
  });
  const storyId = board.addBlock({
    type: STORY_TYPE,
    x: 0,
    y: 0,
    w: 300,
    h: 220,
    props: newStoryProps(),
    text: 'Login',
  });
  new StoryModel(board, storyId).setDescription('As a user I sign in');
  const kanban = new KanbanModel(board, kanbanId);
  const column = kanban.read().columns[0]?.id as string;
  const cardId = kanban.addCard(column, 'Checkout') as string;
  return {
    board,
    storyId,
    kanbanId,
    cardId,
    storyRef: { kind: 'STORY', blockId: storyId },
    cardRef: { kind: 'KANBAN_CARD', blockId: kanbanId, cardId },
  };
}
