import { TestEngine, createTestEngine } from '../testing/helpers';
import { KANBAN_TYPE, KanbanModel, newKanbanProps } from './kanban-model';
import { STORY_ESTIMATE_ACTION, storyLabel } from './story';
import { STORY_TYPE, StoryModel, newStoryProps, readStory } from './story-model';

describe('story block', () => {
  let t: TestEngine;
  let id: string;
  let model: StoryModel;

  beforeEach(() => {
    t = createTestEngine();
    id = t.board.addBlock({
      type: STORY_TYPE,
      x: 0,
      y: 0,
      w: 300,
      h: 220,
      props: newStoryProps(),
      text: 'Checkout',
    });
    model = new StoryModel(t.board, id);
  });
  afterEach(() => t.destroy());

  const card = (): HTMLElement => t.container.querySelector('.be-story') as HTMLElement;

  describe('rendering', () => {
    it('when a story is shown then title, description, criteria and estimate appear as text', () => {
      model.setDescription('Pay with <b>card</b> https://example.org');
      const done = model.addCriterion('Card accepted') as string;
      model.addCriterion('Receipt sent');
      model.updateCriterion(done, { done: true });
      model.setEstimate('8');

      expect(card().querySelector('.be-story-title')?.textContent, 'title').toBe('Checkout');
      expect(card().querySelector('.be-story-description b'), 'no markup').toBeNull();
      expect(
        card().querySelector('.be-story-description a')?.getAttribute('rel'),
        'safe link',
      ).toBe('noopener noreferrer nofollow');
      expect(
        Array.from(card().querySelectorAll('.be-story-criterion')).map(
          (li) => (li as HTMLElement).dataset['done'],
        ),
        'criteria',
      ).toEqual(['true', 'false']);
      expect(card().querySelector('.be-story-estimate')?.textContent, 'estimate').toBe('8');
      expect(card().getAttribute('aria-label'), 'label').toBe(
        'Story: Checkout, estimate 8, 1 of 2 acceptance criteria done',
      );
    });

    it('when nothing is filled in then the card says so', () => {
      model.setTitle('');

      expect(card().querySelector('.be-story-estimate')?.textContent, 'no estimate').toBe('–');
      expect(storyLabel(readStory(t.board, id)), 'label').toBe(
        'Story: Untitled story, not estimated, no acceptance criteria',
      );
    });
  });

  describe('estimating chip', () => {
    it('when the app says a round is open then the chip shows and asks for the dialog', () => {
      t.destroy();
      let open = false;
      const listeners = new Set<() => void>();
      t = createTestEngine({
        services: {
          estimates: {
            isOpen: () => open,
            onChange: (l) => {
              listeners.add(l);
              return () => listeners.delete(l);
            },
          },
        },
      });
      id = t.board.addBlock({
        type: STORY_TYPE,
        x: 0,
        y: 0,
        w: 300,
        h: 220,
        props: newStoryProps(),
        text: 'S',
      });
      const requests: string[] = [];
      t.engine.blockRequested.on((r) => requests.push(r.action));
      const chip = (): HTMLButtonElement =>
        t.container.querySelector('.be-story-poker') as HTMLButtonElement;
      expect(chip().style.display, 'hidden').toBe('none');

      open = true;
      listeners.forEach((l) => l());
      expect(chip().style.display, 'shown').toBe('');
      chip().click();

      expect(requests, 'asked').toEqual([STORY_ESTIMATE_ACTION]);
      t.board.deleteItems([id]);
      expect(listeners.size, 'unsubscribed').toBe(0);
    });
  });

  describe('opening', () => {
    it('when a story is double-clicked or Enter is pressed then the host opens its editor', () => {
      const opened: string[] = [];
      t.engine.blockOpened.on((b) => opened.push(b));

      t.engine.doubleClick(t.at(50, 50, { detail: 2 }));
      t.engine.selection.set([id]);
      t.key('Enter');

      expect(opened, 'opened twice').toEqual([id, id]);
    });
  });

  describe('from a kanban', () => {
    it('when a card is dropped onto the canvas with Shift then it becomes a story card', () => {
      const kanban = t.board.addBlock({
        type: KANBAN_TYPE,
        x: 400,
        y: 0,
        w: 700,
        h: 400,
        props: newKanbanProps(),
      });
      const k = new KanbanModel(t.board, kanban);
      const cardId = k.addCard(k.read().columns[0]?.id as string, 'Refunds') as string;
      k.updateCard(cardId, { points: 5 });
      const root = t.container.querySelector('.be-kanban') as HTMLElement;
      root.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 700, bottom: 400, width: 700, height: 400 }) as DOMRect;
      const el = root.querySelector('[data-card-id]') as HTMLElement;
      const fire = (type: string, x: number, y: number): void => {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 3,
            button: 0,
            clientX: x,
            clientY: y,
            shiftKey: true,
          }),
        );
      };

      fire('pointerdown', 10, 10);
      fire('pointermove', 900, 600);
      fire('pointerup', 900, 600);

      const story = t.board.blocks().find((b) => b.type === STORY_TYPE && b.id !== id);
      expect(story, 'story card').toBeDefined();
      expect(readStory(t.board, story?.id as string), 'title and points').toMatchObject({
        title: 'Refunds',
        estimate: '5',
      });
    });
  });
});
