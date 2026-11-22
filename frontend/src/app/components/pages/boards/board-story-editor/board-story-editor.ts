import { Component, computed, effect, input, output, signal } from '@angular/core';
import {
  FormField,
  FormRoot,
  form,
  maxLength,
  readonly,
  required,
  validate,
} from '@angular/forms/signals';

import { STORY_LIMITS, StoryModel, StoryState, isValidEstimate } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../board-engine/engine';
import { WithSpan } from '../../../../util/tracing';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { Icon } from '../../../shared/icon/icon';

let nextId = 0;

const EMPTY: StoryState = {
  title: '',
  description: '',
  criteria: [],
  estimate: null,
  pokerRoundId: null,
};

/**
 * The side panel of a story card (architecture 3.10): title and description are edited live
 * (every keystroke the smallest Y.Text edit, edits of others show up here), acceptance criteria
 * are added, ticked off, reworded and removed, the estimate is a short deck-like value. Each
 * discrete change is one undo step of the board.
 */
@Component({
  selector: 'drawboard-board-story-editor',
  imports: [FormField, FormRoot, FieldErrors, Icon],
  templateUrl: './board-story-editor.html',
  host: { '(keydown.escape)': 'close()' },
})
export class BoardStoryEditor {
  readonly engine = input.required<BoardEngine>();
  readonly blockId = input.required<string>();
  /** Planning poker is available to the caller (not for VIEWER-link guests). */
  readonly poker = input(false);
  /** "Planning poker": the page opens the estimation dialog of this card. */
  readonly estimate = output();
  readonly closed = output();

  protected readonly ids = `story-${nextId++}`;
  protected readonly limits = STORY_LIMITS;
  protected readonly readOnly = signal(false);

  protected readonly model = computed(
    () => new StoryModel(this.engine().board, this.blockId(), () => this.engine().stopCapturing()),
  );
  /** Everything as the document has it now. */
  protected readonly story = signal<StoryState>(EMPTY);
  /** Title and description as typed here; replaced only by edits of others. */
  protected readonly title = signal('');
  protected readonly description = signal('');

  private readonly criterionDraft = signal({ text: '' });
  protected readonly criterionForm = form(
    this.criterionDraft,
    (path) => {
      required(path.text, { message: 'Required.' });
      maxLength(path.text, STORY_LIMITS.maxCriterion, {
        message: `At most ${STORY_LIMITS.maxCriterion} characters.`,
      });
    },
    {
      submission: {
        action: () => {
          const text = this.criterionDraft().text.trim();
          if (text !== '' && !this.readOnly() && this.model().addCriterion(text)) {
            this.criterionDraft.set({ text: '' });
            this.criterionForm.text().reset();
          }
          return Promise.resolve(undefined);
        },
      },
    },
  );

  private readonly estimateDraft = signal({ value: '' });
  protected readonly estimateForm = form(
    this.estimateDraft,
    (path) => {
      readonly(path.value, () => this.readOnly());
      validate(path.value, ({ value }) => {
        const v = value().trim();
        return v === '' || isValidEstimate(v)
          ? undefined
          : { kind: 'estimate', message: 'One to eight characters, like 5, 13 or XL.' };
      });
    },
    {
      submission: {
        action: () => {
          const v = this.estimateDraft().value.trim();
          if (!this.readOnly()) {
            this.model().setEstimate(v === '' ? null : v);
          }
          return Promise.resolve(undefined);
        },
      },
    },
  );

  protected readonly doneCount = computed(() => this.story().criteria.filter((c) => c.done).length);
  protected readonly full = computed(
    () => this.story().criteria.length >= STORY_LIMITS.maxCriteria,
  );

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      const id = this.blockId();
      const model = this.model();
      const load = (all: boolean): void => {
        const story = model.read();
        this.story.set(story);
        if (all) {
          this.title.set(story.title);
          this.description.set(story.description);
          this.estimateDraft.set({ value: story.estimate ?? '' });
        }
      };
      load(true);
      this.readOnly.set(engine.readOnly);
      const off = [
        engine.board.observe((change) => {
          if (!change.blocks.has(id)) {
            return;
          }
          if (!engine.board.hasBlock(id)) {
            this.closed.emit(); // deleted (by anyone, or undone)
          } else {
            load(!change.local);
          }
        }),
        engine.readOnlyChanged.on((ro) => this.readOnly.set(ro)),
      ];
      onCleanup(() => off.forEach((o) => o()));
    });
  }

  @WithSpan('BoardStoryEditor.editTitle')
  protected editTitle(value: string): void {
    this.title.set(value);
    this.model().setTitle(value);
  }

  @WithSpan('BoardStoryEditor.editDescription')
  protected editDescription(value: string): void {
    this.description.set(value);
    this.model().setDescription(value);
  }

  @WithSpan('BoardStoryEditor.toggleCriterion')
  protected toggleCriterion(id: string, done: boolean): void {
    this.model().updateCriterion(id, { done });
  }

  @WithSpan('BoardStoryEditor.rewordCriterion')
  protected rewordCriterion(id: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed !== '') {
      this.model().updateCriterion(id, { text: trimmed });
    }
  }

  @WithSpan('BoardStoryEditor.removeCriterion')
  protected removeCriterion(id: string): void {
    this.model().deleteCriterion(id);
  }

  @WithSpan('BoardStoryEditor.openPoker')
  protected openPoker(): void {
    this.estimate.emit();
  }

  @WithSpan('BoardStoryEditor.close')
  protected close(): void {
    this.closed.emit();
  }
}
