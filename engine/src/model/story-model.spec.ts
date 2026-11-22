import * as Y from 'yjs';

import { BoardDoc } from './board-doc.js';
import { History } from '../testing/undo.js';
import {
  STORY_LIMITS,
  STORY_TYPE,
  StoryModel,
  isValidEstimate,
  newStoryProps,
  readStory,
  storyPropsToFile,
  storyPropsToY,
} from './story-model.js';

const ROUND = '0192aaaa-0000-7000-8000-000000000001';

describe('story model', () => {
  let board: BoardDoc;
  let history: History;
  let model: StoryModel;
  let id: string;

  beforeEach(() => {
    board = new BoardDoc();
    history = new History(board);
    id = board.addBlock({
      type: STORY_TYPE,
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      props: newStoryProps(),
      text: 'Login',
    });
    model = new StoryModel(board, id, () => history.stopCapturing());
    history.stopCapturing();
  });

  afterEach(() => {
    history.destroy();
    board.destroy();
  });

  describe('editing', () => {
    it('when title and description are typed then they are stored as text', () => {
      model.setTitle('Login with OIDC');
      model.setDescription('As a user I want to sign in.');

      expect(model.read(), 'story').toMatchObject({
        title: 'Login with OIDC',
        description: 'As a user I want to sign in.',
        estimate: null,
        pokerRoundId: null,
      });
    });

    it('when criteria are added, ticked, reworded and removed then the list follows', () => {
      const a = model.addCriterion('Redirects to the provider') as string;
      const b = model.addCriterion('Shows the name') as string;

      model.updateCriterion(a, { done: true });
      model.updateCriterion(b, { text: 'Shows the display name' });
      model.deleteCriterion(a);

      expect(model.read().criteria, 'criteria').toEqual([
        { id: b, text: 'Shows the display name', done: false },
      ]);
    });

    it('when the criteria limit is reached then no criterion is added', () => {
      for (let i = 0; i < STORY_LIMITS.maxCriteria; i++) {
        model.addCriterion(`c${i}`);
      }

      expect(model.addCriterion('one more'), 'refused').toBeUndefined();
    });

    it('when an estimate is set then only deck-like values are taken', () => {
      expect(model.setEstimate('13'), 'number').toBe(true);
      expect(model.setEstimate(' 5'), 'leading space').toBe(false);
      expect(model.setEstimate('123456789'), 'too long').toBe(false);
      expect(model.setEstimate('a​b'), 'format character').toBe(false);
      expect(model.read().estimate, 'stored').toBe('13');
      model.setEstimate(null);
      expect(model.read().estimate, 'cleared').toBeNull();
    });

    it('when the description is missing then it is created on the first edit', () => {
      (board.blocksMap.get(id)?.get('props') as Y.Map<unknown>).delete('description');

      model.setDescription('Now');

      expect(model.read().description, 'created').toBe('Now');
    });
  });

  describe('planning poker', () => {
    it('when a round finishes then the estimate is written and the round id cleared in one step', () => {
      model.setPokerRound(ROUND);

      expect(model.finishRound(ROUND, '8'), 'written').toBe(true);
      expect(model.read(), 'story').toMatchObject({ estimate: '8', pokerRoundId: null });
      history.undo();
      expect(model.read(), 'one undo step').toMatchObject({ estimate: null, pokerRoundId: ROUND });
    });

    it('when another round is on the card now then finishing an old one changes nothing', () => {
      model.setPokerRound(ROUND);

      expect(model.finishRound('0192bbbb-0000-7000-8000-000000000002', '3'), 'refused').toBe(false);
      expect(model.read().pokerRoundId, 'kept').toBe(ROUND);
    });

    it('when a cancelled round finishes without estimate then only the round id goes', () => {
      model.setEstimate('5');
      model.setPokerRound(ROUND);

      model.finishRound(ROUND, null);

      expect(model.read(), 'story').toMatchObject({ estimate: '5', pokerRoundId: null });
    });

    it('when a round id is not an id then it is not written', () => {
      model.setPokerRound('not-a-round');

      expect(model.read().pokerRoundId, 'nothing').toBeNull();
      expect(model.finishRound(ROUND, 'way too long'), 'invalid estimate').toBe(false);
    });
  });

  describe('reading foreign data', () => {
    it('when the props hold junk then defaults and valid parts are shown', () => {
      const props = board.blocksMap.get(id)?.get('props') as Y.Map<unknown>;
      board.transact(() => {
        props.set('description', 'plain string');
        props.set('estimate', '<b>');
        props.set('pokerRoundId', 42);
        const list = new Y.Array<unknown>();
        const good = new Y.Map<unknown>();
        good.set('id', '11111111-1111-4111-8111-111111111111');
        good.set('text', 7);
        const dup = new Y.Map<unknown>();
        dup.set('id', '11111111-1111-4111-8111-111111111111');
        const bad = new Y.Map<unknown>();
        bad.set('id', '__proto__');
        list.push([good, dup, bad, 'x']);
        props.set('criteria', list);
      });

      expect(readStory(board, id), 'read').toEqual({
        title: 'Login',
        description: '',
        criteria: [{ id: '11111111-1111-4111-8111-111111111111', text: '', done: false }],
        estimate: '<b>',
        pokerRoundId: null,
      });
      expect(isValidEstimate('<b>'), 'the estimate is plain text, rendered as text').toBe(true);
    });
  });

  describe('file form', () => {
    it('when a story goes to the file form and back then it is the same without the round', () => {
      model.setDescription('D');
      model.addCriterion('C');
      model.setEstimate('XL');
      model.setPokerRound(ROUND);

      const file = storyPropsToFile(board, id);
      const copy = new BoardDoc();
      const copyId = copy.addBlock({
        type: STORY_TYPE,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        props: storyPropsToY(file),
        text: 'Login',
      });

      expect(readStory(copy, copyId), 'copy').toEqual({ ...model.read(), pokerRoundId: null });
      copy.destroy();
    });
  });
});
