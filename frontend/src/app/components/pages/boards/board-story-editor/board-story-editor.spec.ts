import { inputBinding, outputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import * as Y from 'yjs';

import {
  STORY_LIMITS,
  STORY_TYPE,
  StoryModel,
  newStoryProps,
} from '../../../../../board-engine/blocks/story-model';
import { BoardEngine } from '../../../../../board-engine/engine';
import { BoardDoc } from '../../../../../board-engine/model/board-doc';
import { buttonByLabel, textOf } from '../../../../test/dom';
import { BoardStoryEditor } from './board-story-editor';

describe('BoardStoryEditor', () => {
  let fixture: ComponentFixture<BoardStoryEditor>;
  let board: BoardDoc;
  let engine: BoardEngine;
  let model: StoryModel;
  let id: string;
  let closed: number;

  async function render(readOnly = false): Promise<void> {
    board = new BoardDoc();
    engine = new BoardEngine(document.createElement('div'), board, { readOnly });
    id = board.addBlock({
      type: STORY_TYPE,
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      props: newStoryProps(),
      text: 'Login',
    });
    model = new StoryModel(board, id);
    model.addCriterion('Redirects');
    closed = 0;
    fixture = TestBed.createComponent(BoardStoryEditor, {
      bindings: [
        inputBinding('engine', () => engine),
        inputBinding('blockId', () => id),
        outputBinding('closed', () => closed++),
      ],
    });
    await fixture.whenStable();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(selector: string): T => el().querySelector(selector) as T;
  function type(
    target: HTMLInputElement | HTMLTextAreaElement,
    value: string,
    event = 'input',
  ): void {
    target.value = value;
    target.dispatchEvent(new Event(event));
  }
  async function submit(form: number): Promise<void> {
    const forms = el().querySelectorAll('form');
    forms[form]?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
  }

  afterEach(() => {
    engine.destroy();
    board.destroy();
  });

  describe('editing', () => {
    it('when title and description are typed then the card follows live', async () => {
      await render();

      type(q('input[type=text]'), 'Login with OIDC');
      type(q('textarea'), 'Why it matters');

      expect(model.read(), 'story').toMatchObject({
        title: 'Login with OIDC',
        description: 'Why it matters',
      });
    });

    it('when criteria are added, ticked, reworded and removed then the card follows', async () => {
      await render();

      type(q('input[placeholder="Add a criterion"]'), 'Shows the name');
      await submit(0);
      const boxes = el().querySelectorAll<HTMLInputElement>('input[type=checkbox]');
      boxes[0]!.checked = true;
      boxes[0]!.dispatchEvent(new Event('change'));
      type(q('input[aria-label="Criterion 2"]'), 'Shows the display name', 'change');
      await fixture.whenStable();

      expect(
        model.read().criteria.map((c) => [c.text, c.done]),
        'criteria',
      ).toEqual([
        ['Redirects', true],
        ['Shows the display name', false],
      ]);
      expect(textOf(fixture), 'count').toContain('1 of 2 done');

      buttonByLabel(fixture, 'Remove criterion 1').click();
      expect(model.read().criteria.length, 'removed').toBe(1);
    });

    it('when an empty criterion is submitted then nothing is added', async () => {
      await render();

      await submit(0);

      expect(model.read().criteria.length, 'unchanged').toBe(1);
      expect(textOf(fixture), 'message').toContain('Required.');
    });

    it('when the estimate is set then it is stored; an invalid one is refused', async () => {
      await render();

      type(q('input[aria-describedby$="-estimate-errors"]'), 'way too long');
      await submit(1);
      expect(model.read().estimate, 'refused').toBeNull();
      expect(textOf(fixture), 'message').toContain('One to eight characters');

      type(q('input[aria-describedby$="-estimate-errors"]'), 'XL');
      await submit(1);
      expect(model.read().estimate, 'stored').toBe('XL');

      type(q('input[aria-describedby$="-estimate-errors"]'), '');
      await submit(1);
      expect(model.read().estimate, 'cleared').toBeNull();
    });

    it('when the criteria are full then the add form is gone', async () => {
      await render();
      for (let i = 1; i < STORY_LIMITS.maxCriteria; i++) {
        model.addCriterion(`c${i}`);
      }
      await fixture.whenStable();

      expect(q('input[placeholder="Add a criterion"]'), 'no form').toBeNull();
    });
  });

  describe('collaboration', () => {
    it('when someone else edits the story then the panel shows it', async () => {
      await render();
      const remote = new BoardDoc(new Y.Doc(), false);
      Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(board.doc));
      remote.doc.on('update', (u: Uint8Array) => Y.applyUpdate(board.doc, u, 'remote'));

      new StoryModel(remote, id).setDescription('From afar');
      await fixture.whenStable();

      expect(q<HTMLTextAreaElement>('textarea').value, 'remote description').toBe('From afar');
      remote.destroy();
    });

    it('when the story is deleted then the panel closes', async () => {
      await render();

      board.deleteItems([id]);

      expect(closed, 'closed').toBe(1);
    });
  });

  describe('read-only', () => {
    it('when the board is read-only then nothing can be changed', async () => {
      await render(true);

      expect(q<HTMLInputElement>('input[type=text]').readOnly, 'title').toBe(true);
      expect(q('input[placeholder="Add a criterion"]'), 'no add form').toBeNull();
      expect(q<HTMLInputElement>('input[type=checkbox]').disabled, 'criteria').toBe(true);
      buttonByLabel(fixture, 'Close the story card').click();
      expect(closed, 'closed').toBe(1);
    });
  });
});
