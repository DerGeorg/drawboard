import type { BoardFile } from '../io/board-file.js';
import { TemplateBuilder } from './template-builder.js';

/** One template that ships with the frontend (architecture 3.12). */
export interface BuiltinTemplate {
  /** Stable key, never shown. */
  id: string;
  /** Becomes the title of the new board (the user can change it). */
  title: string;
  description: string;
  /** What a copy starts with; goes through `parseBoardFile` in the tests like an import. */
  file: BoardFile;
}

const STICKY = {
  yellow: '#fde68a',
  pink: '#fecdd3',
  blue: '#bae6fd',
  green: '#bbf7d0',
  orange: '#fed7aa',
  purple: '#ddd6fe',
};

const TINT = {
  green: '#ecfdf5',
  red: '#fef2f2',
  blue: '#eff6ff',
  yellow: '#fefce8',
  purple: '#f5f3ff',
  orange: '#fff7ed',
  grey: '#f8fafc',
};

/** Three columns with a title, a hint and room for notes (the shape of most retros). */
function threeColumns(
  title: string,
  intro: string,
  columns: readonly { title: string; hint: string; fill: string }[],
): BoardFile {
  const t = new TemplateBuilder(title);
  t.text(title, 0, 0, 1380, 56, 32);
  t.text(intro, 0, 60, 1380, 40, 18);
  columns.forEach((column, i) => {
    const x = i * 460;
    const frame = t.frame(column.title, x, 130, 440, 740, column.fill);
    t.hint(column.hint, x + 20, 170, 400, { in: frame });
  });
  return t.build();
}

function retroStartStopContinue(): BoardFile {
  return threeColumns(
    'Retro: Start, Stop, Continue',
    'Add a sticky per idea, then group similar ones and pick what to try next sprint.',
    [
      { title: 'Start', hint: 'What should we begin doing?', fill: TINT.green },
      { title: 'Stop', hint: 'What should we stop doing?', fill: TINT.red },
      { title: 'Continue', hint: 'What works well and should stay?', fill: TINT.blue },
    ],
  );
}

function retroMadSadGlad(): BoardFile {
  return threeColumns(
    'Retro: Mad, Sad, Glad',
    'Add a sticky per feeling. Be honest, name the situation, not the person.',
    [
      { title: 'Mad', hint: 'What frustrated or annoyed us?', fill: TINT.red },
      { title: 'Sad', hint: 'What disappointed us or felt like a loss?', fill: TINT.purple },
      { title: 'Glad', hint: 'What made us happy or proud?', fill: TINT.green },
    ],
  );
}

function retro4L(): BoardFile {
  const t = new TemplateBuilder('Retro: 4L');
  t.text('Retro: 4L', 0, 0, 1280, 56, 32);
  t.text(
    'Add a sticky per idea. Look back at the sprint, then vote on what to follow up.',
    0,
    60,
    1280,
    40,
    18,
  );
  const quadrants = [
    { title: 'Liked', hint: 'What did we enjoy or like?', fill: TINT.green },
    { title: 'Learned', hint: 'What did we learn?', fill: TINT.blue },
    { title: 'Lacked', hint: 'What was missing?', fill: TINT.orange },
    { title: 'Longed for', hint: 'What did we wish for?', fill: TINT.purple },
  ];
  quadrants.forEach((q, i) => {
    const x = (i % 2) * 640;
    const y = 130 + Math.floor(i / 2) * 460;
    const frame = t.frame(q.title, x, y, 620, 440, q.fill);
    t.hint(q.hint, x + 20, y + 40, 580, { in: frame });
  });
  return t.build();
}

function kanban(): BoardFile {
  const t = new TemplateBuilder('Kanban');
  t.text('Kanban', 0, 0, 1180, 56, 32);
  t.text('Add a card per task with + and drag it from column to column.', 0, 60, 1180, 40, 18);
  t.kanban('Team board', ['To do', 'In progress', 'Review', 'Done'], 0, 120, 1180, 640);
  return t.build();
}

function sprintPlanning(): BoardFile {
  const t = new TemplateBuilder('Sprint planning');
  t.text('Sprint planning', 0, 0, 1500, 56, 32);
  const goal = t.frame('Sprint goal', 0, 90, 1500, 200, TINT.yellow);
  t.text(
    'We will ... so that ...\n(One or two sentences: what do we want to reach this sprint?)',
    24,
    140,
    1450,
    110,
    22,
    { in: goal },
  );
  t.kanban('Sprint backlog', ['Backlog', 'Selected', 'In progress', 'Done'], 0, 330, 1000, 640);
  const stories = t.frame('Story cards', 1040, 330, 460, 640, TINT.grey);
  t.hint(
    'Add story cards here, estimate them with planning poker, then pull them into the backlog.',
    1060,
    370,
    420,
    {
      in: stories,
    },
  );
  t.story(
    'As a <user> I want <goal> so that <benefit>',
    'Replace this example with your first story.',
    ['Given ... when ... then ...'],
    1120,
    480,
    { in: stories },
  );
  return t.build();
}

function brainstorming(): BoardFile {
  const t = new TemplateBuilder('Brainstorming');
  t.text('Brainstorming', 0, 0, 1600, 56, 32);
  t.text(
    '1. Write the question in the middle   2. Add a sticky per idea, no judging   3. Group similar ideas   4. Vote',
    0,
    60,
    1600,
    40,
    18,
  );
  t.shape('ellipse', 'Our question: How might we ...?', 0, 130, 520, 220, STICKY.yellow);
  const ideas = t.frame('Ideas', 0, 380, 1040, 620, TINT.grey);
  t.hint('Quantity first: add as many stickies as you can.', 20, 420, 1000, { in: ideas });
  const groups = t.frame('Groups', 1080, 130, 520, 870, TINT.blue);
  t.hint('Move similar ideas here and name each group.', 1100, 170, 480, { in: groups });
  return t.build();
}

function userStoryMap(): BoardFile {
  const t = new TemplateBuilder('User story map');
  const width = 1900;
  t.text('User story map', 0, 0, width, 56, 32);
  t.text(
    'Activities along the top, the steps under them, then stories by release. Left to right is the order the user does things.',
    0,
    60,
    width,
    40,
    18,
  );
  const backbone = t.frame('Backbone: activities and steps', 0, 120, width, 440, TINT.grey);
  t.hint('Activity: what the user wants to get done. Step: how they do it.', 24, 160, 1200, {
    in: backbone,
  });
  for (let i = 0; i < 4; i++) {
    const x = 30 + i * 465;
    t.sticky(`Activity ${i + 1}`, x, 230, 440, 120, STICKY.orange, { in: backbone });
    t.sticky('Step', x, 390, 215, 120, STICKY.blue, { in: backbone });
    t.sticky('Step', x + 225, 390, 215, 120, STICKY.blue, { in: backbone });
  }
  const releases = [
    { title: 'Release 1 (MVP)', fill: TINT.green },
    { title: 'Release 2', fill: TINT.blue },
    { title: 'Later', fill: TINT.purple },
  ];
  releases.forEach((release, i) => {
    const y = 600 + i * 360;
    const frame = t.frame(release.title, 0, y, width, 340, release.fill);
    if (i === 0) {
      t.hint('Put a sticky per story under its step, most important on top.', 24, y + 40, 1200, {
        in: frame,
      });
    }
  });
  return t.build();
}

function swot(): BoardFile {
  const t = new TemplateBuilder('SWOT analysis');
  t.text('SWOT analysis', 0, 0, 1400, 56, 32);
  t.text(
    'Add a sticky per point. Strengths and weaknesses are inside, opportunities and threats outside.',
    0,
    60,
    1400,
    40,
    18,
  );
  t.text('Helpful', 140, 120, 600, 36, 20);
  t.text('Harmful', 780, 120, 600, 36, 20);
  t.text('Internal', 0, 360, 130, 36, 20);
  t.text('External', 0, 820, 130, 36, 20);
  const quadrants = [
    {
      title: 'Strengths',
      hint: 'What do we do well? Where are we better than others?',
      fill: TINT.green,
    },
    { title: 'Weaknesses', hint: 'What could we improve? What do we lack?', fill: TINT.red },
    { title: 'Opportunities', hint: 'What trends or changes could we use?', fill: TINT.blue },
    { title: 'Threats', hint: 'What could harm us? What are others doing?', fill: TINT.orange },
  ];
  quadrants.forEach((q, i) => {
    const x = 140 + (i % 2) * 640;
    const y = 160 + Math.floor(i / 2) * 460;
    const frame = t.frame(q.title, x, y, 620, 440, q.fill);
    t.hint(q.hint, x + 20, y + 40, 580, { in: frame });
  });
  return t.build();
}

/** Every built-in template, in the order of the picker. */
export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    id: 'retro-start-stop-continue',
    title: 'Retro: Start, Stop, Continue',
    description: 'Three columns for what to begin, quit and keep doing.',
    file: retroStartStopContinue(),
  },
  {
    id: 'retro-mad-sad-glad',
    title: 'Retro: Mad, Sad, Glad',
    description: 'Look at the sprint through feelings.',
    file: retroMadSadGlad(),
  },
  {
    id: 'retro-4l',
    title: 'Retro: 4L',
    description: 'Liked, Learned, Lacked and Longed for in four quadrants.',
    file: retro4L(),
  },
  {
    id: 'kanban',
    title: 'Kanban',
    description: 'A kanban board with four columns.',
    file: kanban(),
  },
  {
    id: 'sprint-planning',
    title: 'Sprint planning',
    description: 'Sprint goal, sprint backlog and an area for story cards.',
    file: sprintPlanning(),
  },
  {
    id: 'brainstorming',
    title: 'Brainstorming',
    description: 'A question, an area for ideas and one for groups.',
    file: brainstorming(),
  },
  {
    id: 'user-story-map',
    title: 'User story map',
    description: 'Activities and steps as backbone, stories sorted by release.',
    file: userStoryMap(),
  },
  {
    id: 'swot',
    title: 'SWOT analysis',
    description: 'Strengths, weaknesses, opportunities and threats.',
    file: swot(),
  },
];

/** A deep copy: the writer must not share objects with the module-level templates. */
export function templateFile(template: BuiltinTemplate): BoardFile {
  return structuredClone(template.file);
}
