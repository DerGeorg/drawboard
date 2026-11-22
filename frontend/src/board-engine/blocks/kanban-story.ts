import {
  NewBlock,
  Point,
  KanbanCard,
  StoryCardInput,
  estimateOfCard,
  pointsOfEstimate,
  STORY_TYPE,
  StoryState,
  storyPropsToY,
} from '@apps/drawboard-engine';

/**
 * A story card as a kanban card: the title is the story's text, description, criteria and
 * estimate are kept as they are, the points are the estimate's number (null for `?` or `XL`).
 */
export function cardFromStory(story: StoryState): StoryCardInput {
  return {
    title: story.title,
    description: story.description,
    criteria: story.criteria.map((c) => ({ ...c })),
    estimate: story.estimate,
    points: pointsOfEstimate(story.estimate),
  };
}

/** A kanban card as a story card centred on `at` (the way back, with Shift or from the editor). */
export function storyFromCard(card: KanbanCard, at: Point): NewBlock {
  return {
    type: STORY_TYPE,
    x: at.x - 150,
    y: at.y - 110,
    w: 300,
    h: 220,
    props: storyPropsToY({
      description: card.description,
      criteria: card.criteria.map((c) => ({ ...c })),
      estimate: estimateOfCard(card),
    }),
    text: card.title,
  };
}
