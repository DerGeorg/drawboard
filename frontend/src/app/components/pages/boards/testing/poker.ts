import { PokerRound, PokerRoundState } from '@apps/drawboard-api';

export const ROUND_ID = '0192aaaa-0000-7000-8000-000000000001';
export const STORY_BLOCK = '11111111-1111-4111-8111-111111111111';

/** A round as getPokerRound answers it; FIBONACCI deck, open, nobody joined. */
export function aPokerRound(overrides: Partial<PokerRound> = {}): PokerRound {
  return {
    id: ROUND_ID,
    storyBlockId: STORY_BLOCK,
    title: 'Login',
    deck: { kind: 'FIBONACCI', values: ['0', '1', '2', '3', '5', '8', '13', '21', '?', 'coffee'] },
    state: PokerRoundState.OPEN,
    facilitatorId: 'id-alice',
    facilitatorName: 'Alice Admin',
    createdAt: '2026-11-10T08:00:00Z',
    version: 1,
    participants: [],
    ...overrides,
  };
}
