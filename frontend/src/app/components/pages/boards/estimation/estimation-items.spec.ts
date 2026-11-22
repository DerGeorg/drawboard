import { KanbanModel, StoryModel } from '@apps/drawboard-engine';
import { aBoardWithCards } from '../testing/estimation';
import {
  candidatesOf,
  cardsPerPerson,
  checkWrite,
  cleanTitle,
  display,
  isPlainLine,
  keysOfSelection,
  liveItem,
  magicColumns,
  refKey,
  roundsFor,
  writeDecision,
} from './estimation-items';

describe('estimation items', () => {
  describe('candidatesOf', () => {
    it('when a board has story cards and kanban cards then both are offered top to bottom', () => {
      const { board, storyId, kanbanId, cardId } = aBoardWithCards();

      const candidates = candidatesOf(board);

      expect(
        candidates.map((c) => [c.title, c.group]),
        'story first (higher up), then the kanban card',
      ).toEqual([
        ['Login', undefined],
        ['Checkout', 'Sprint board'],
      ]);
      expect(candidates[0]?.key, 'story key').toBe(storyId);
      expect(candidates[1]?.key, 'card key').toBe(`${kanbanId}/${cardId}`);
      expect(keysOfSelection(candidates, [kanbanId]), 'a selected kanban brings its cards').toEqual(
        [`${kanbanId}/${cardId}`],
      );
      board.destroy();
    });

    it('when a title has line breaks, control characters or is empty then it is cleaned', () => {
      expect(cleanTitle('  Log\nin\u0007 now  ', 'x'), 'one line').toBe('Log in now');
      expect(cleanTitle('a\u2028b', 'x'), 'no line separator').toBe('a b');
      expect(cleanTitle(' \n ', 'Untitled'), 'fallback').toBe('Untitled');
      expect(Array.from(cleanTitle('é'.repeat(300), 'x')).length, '200 characters').toBe(200);
      expect(isPlainLine('fine'), 'plain').toBe(true);
      expect(isPlainLine('two\nlines'), 'line break').toBe(false);
      expect(isPlainLine('zero\u200bwidth'), 'format character').toBe(false);
    });
  });

  describe('liveItem and writing results (E21)', () => {
    it('when the block and card match the ref then the live title and value are read', () => {
      const { board, storyRef, cardRef } = aBoardWithCards();

      expect(liveItem(board, storyRef), 'story').toEqual({
        title: 'Login',
        description: 'As a user I sign in',
        estimate: null,
      });
      expect(liveItem(board, cardRef)?.title, 'card').toBe('Checkout');
      board.destroy();
    });

    it('when the block is gone, has another type or the card is gone then nothing is written', () => {
      const { board, storyId, kanbanId, cardId } = aBoardWithCards();
      const wrongType = { kind: 'STORY' as const, blockId: kanbanId };
      const wrongCard = { kind: 'KANBAN_CARD' as const, blockId: storyId, cardId };
      const goneCard = { kind: 'KANBAN_CARD' as const, blockId: kanbanId, cardId: storyId };
      const noCard = { kind: 'KANBAN_CARD' as const, blockId: kanbanId };

      for (const [ref, what] of [
        [wrongType, 'story ref on a kanban'],
        [wrongCard, 'card ref on a story'],
        [goneCard, 'unknown card'],
        [noCard, 'card ref without card id'],
        [{ kind: 'STORY' as const, blockId: 'gone' }, 'deleted block'],
      ] as const) {
        expect(checkWrite(board, ref, '5'), what).toEqual({ ok: false, reason: 'missing' });
        expect(writeDecision(board, ref, '5'), `${what}: not written`).toBe(false);
      }
      board.destroy();
    });

    it('when a story card matches then any valid estimate is written', () => {
      const { board, storyId, storyRef } = aBoardWithCards();

      expect(checkWrite(board, storyRef, 'X'.repeat(9)).ok, 'too long').toBe(false);
      expect(writeDecision(board, storyRef, 'XL'), 'written').toBe(true);

      expect(new StoryModel(board, storyId).read().estimate, 'estimate').toBe('XL');
      board.destroy();
    });

    it('when a kanban card matches then only whole numbers 0..999 go in, as estimate and points', () => {
      const { board, kanbanId, cardId, cardRef } = aBoardWithCards();

      for (const value of ['XL', '?', '1.5', '1000', '05']) {
        expect(checkWrite(board, cardRef, value), value).toMatchObject({
          ok: false,
          reason: 'value',
        });
      }
      expect(writeDecision(board, cardRef, '8'), 'written').toBe(true);

      const card = new KanbanModel(board, kanbanId).card(cardId);
      expect([card?.estimate, card?.points], 'estimate and points').toEqual(['8', 8]);
      expect(checkWrite(board, cardRef, '13'), 'shows the current value').toMatchObject({
        ok: true,
        live: { estimate: '8', points: 8 },
      });
      board.destroy();
    });
  });

  describe('helpers', () => {
    it('when the deck has a coffee card then Magic leaves it out but keeps the parking column', () => {
      expect(
        magicColumns({ kind: 'FIBONACCI', values: ['1', '2', '?', 'coffee'] }),
        'columns',
      ).toEqual(['1', '2', '?']);
      expect(magicColumns({ kind: 'CUSTOM' }), 'no values').toEqual([]);
      expect(display('coffee'), 'cup').toBe('☕');
      expect(refKey({ kind: 'KANBAN_CARD', blockId: 'b' }), 'card without id').toBe('b/');
    });

    it('when rounds and cards per person are converted then the limits hold', () => {
      expect(cardsPerPerson(3, 10, 5), '3 rounds of 2 cards').toBe(6);
      expect(cardsPerPerson(3, 0, 5), 'no cards').toBe(0);
      expect(roundsFor(6, 10, 5), 'back again').toBe(3);
      expect(roundsFor(100, 10, 5), 'never more rounds than people').toBe(5);
      expect(roundsFor(100, 10, 30), 'never more than 10').toBe(10);
      expect(roundsFor(0, 10, 5), 'at least one').toBe(1);
      expect(roundsFor(3, 0, 5), 'no cards').toBe(1);
    });
  });
});
