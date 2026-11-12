import { HttpContext } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  disabled,
  form,
  maxLength,
  pattern,
  required,
} from '@angular/forms/signals';
import { MemberList, SharingService } from '@apps/drawboard-api';

import { LABEL_NAMES, STICKY_OUT } from '../../../../../board-engine/blocks/kanban';
import {
  KANBAN_LABEL_KEYS,
  KANBAN_LIMITS,
  KanbanCard,
  KanbanLabel,
  KanbanModel,
  labelColor,
} from '../../../../../board-engine/blocks/kanban-model';
import { BoardEngine } from '../../../../../board-engine/engine';
import { ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { WithSpan } from '../../../../util/tracing';
import { FieldErrors } from '../../../shared/field-errors/field-errors';
import { Icon } from '../../../shared/icon/icon';

interface CardDraft {
  title: string;
  assignee: string;
  due: string;
  points: string;
}

/** Display names that can be assigned: the owner and every user grant (no groups). */
export function assignableNames(members: MemberList): string[] {
  const names = [members.owner, ...members.items.map((m) => m.principal)]
    .filter((p) => p.kind !== 'GROUP')
    .map((p) => p.displayName.trim())
    .filter((n) => n !== '');
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

let nextId = 0;

/**
 * The side panel of one kanban card (opened by a click or Enter on the card): title, assignee
 * (a board member, picked from the members list; guests may not read that list - S1.10 - and
 * see the name only), due date, labels from the fixed palette, story points. Save writes every
 * changed field as one undo step. "Move to the canvas" is the keyboard way of dragging the card
 * out of the kanban.
 */
@Component({
  selector: 'drawboard-board-kanban-card',
  imports: [FormField, FormRoot, FieldErrors, Icon],
  templateUrl: './board-kanban-card.html',
  host: { '(keydown.escape)': 'close()' },
})
export class BoardKanbanCard {
  private readonly sharingApi = inject(SharingService);

  readonly engine = input.required<BoardEngine>();
  readonly boardId = input.required<string>();
  readonly blockId = input.required<string>();
  readonly cardId = input.required<string>();
  /** Guests cannot list members (S1.10): the assignee is shown, not picked. */
  readonly guest = input(false);
  readonly closed = output();

  protected readonly ids = `kanban-card-${nextId++}`;
  protected readonly labels = KANBAN_LABEL_KEYS;
  protected readonly labelNames = LABEL_NAMES;

  private readonly model = computed(
    () => new KanbanModel(this.engine().board, this.blockId(), () => this.engine().stopCapturing()),
  );
  protected readonly card = signal<KanbanCard | undefined>(undefined);
  protected readonly readOnly = signal(false);
  protected readonly selectedLabels = linkedSignal<KanbanLabel[]>(() => [
    ...(this.initial()?.labels ?? []),
  ]);

  /** The card as it was when the panel opened (a remote edit does not reset the draft). */
  private readonly initial = computed(() => {
    this.cardId();
    return this.model().card(this.cardId());
  });
  private readonly draft = linkedSignal<CardDraft>(() => {
    const card = this.initial();
    return {
      title: card?.title ?? '',
      assignee: card?.assignee ?? '',
      due: card?.due ?? '',
      points: card?.points === null || card?.points === undefined ? '' : String(card.points),
    };
  });

  protected readonly cardForm = form(
    this.draft,
    (path) => {
      required(path.title, { message: 'Required.' });
      maxLength(path.title, KANBAN_LIMITS.maxTitle, {
        message: `At most ${KANBAN_LIMITS.maxTitle} characters.`,
      });
      pattern(path.points, /^\d{0,3}$/, { message: 'A whole number from 0 to 999.' });
      disabled(path, () => this.readOnly());
    },
    { submission: { action: () => Promise.resolve(this.save()) } },
  );

  private readonly members = rxResource({
    params: () => (this.guest() ? undefined : { boardId: this.boardId() }),
    // the list only fills a picker: a failure leaves the picker with the current name, no page
    stream: ({ params }) =>
      this.sharingApi.listBoardMembers(params, 'body', false, {
        context: new HttpContext().set(ERRORS_HANDLED_LOCALLY, true),
      }),
  });
  protected readonly membersFailed = computed(() => !!this.members.error());
  /** The names to pick from; the current assignee stays in the list even if they left. */
  protected readonly names = computed(() => {
    const names = this.members.hasValue() ? assignableNames(this.members.value()) : [];
    const current = this.initial()?.assignee;
    return current && !names.includes(current) ? [current, ...names] : names;
  });

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      const blockId = this.blockId();
      const cardId = this.cardId();
      const refresh = (): void => {
        const card = this.model().card(cardId);
        if (!card) {
          this.closed.emit(); // deleted (by anyone, or undone)
          return;
        }
        this.card.set(card);
      };
      refresh();
      this.readOnly.set(engine.readOnly);
      const off = [
        engine.board.observe((change) => {
          if (change.blocks.has(blockId)) {
            refresh();
          }
        }),
        engine.readOnlyChanged.on((ro) => this.readOnly.set(ro)),
      ];
      onCleanup(() => off.forEach((o) => o()));
    });
  }

  protected labelColor(label: KanbanLabel): string {
    return labelColor(label);
  }

  @WithSpan('BoardKanbanCard.toggleLabel')
  protected toggleLabel(label: KanbanLabel): void {
    this.selectedLabels.update((labels) =>
      labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label],
    );
  }

  @WithSpan('BoardKanbanCard.save')
  protected save(): undefined {
    if (this.readOnly()) {
      return undefined;
    }
    const d = this.draft();
    this.model().updateCard(this.cardId(), {
      title: d.title.trim(),
      ...(this.guest() ? {} : { assignee: d.assignee === '' ? null : d.assignee }),
      due: d.due === '' ? null : d.due,
      points: d.points === '' ? null : Number(d.points),
      labels: this.selectedLabels(),
    });
    this.closed.emit();
    return undefined;
  }

  @WithSpan('BoardKanbanCard.remove')
  protected remove(): void {
    this.model().deleteCard(this.cardId());
  }

  /** The keyboard alternative to dragging the card out: a sticky note next to the kanban. */
  @WithSpan('BoardKanbanCard.moveToCanvas')
  protected moveToCanvas(): void {
    const engine = this.engine();
    const block = engine.board.getBlock(this.blockId());
    if (!block) {
      return;
    }
    const at = { x: block.x + block.w + 140, y: block.y + 100 };
    const id = this.model().moveCardOut(this.cardId(), (card) =>
      engine.board.addBlock(STICKY_OUT.sticky(card, at)),
    );
    if (id) {
      engine.selection.set([id]);
    }
  }

  @WithSpan('BoardKanbanCard.close')
  protected close(): void {
    this.closed.emit();
  }
}
