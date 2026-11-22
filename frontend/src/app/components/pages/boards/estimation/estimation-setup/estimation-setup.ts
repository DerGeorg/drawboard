import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  FormField,
  FormRoot,
  applyWhen,
  form,
  max,
  maxLength,
  min,
  required,
  validate,
} from '@angular/forms/signals';
import type { SchemaPath } from '@angular/forms/signals';
import {
  EstimationMode,
  EstimationSettings,
  NewEstimationSession,
  PokerDeckKind,
} from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import {
  DeckChoice,
  DeckPicker,
  parseCustomDeck,
  validateCustomDeck,
} from '../../../../shared/deck-picker/deck-picker';
import { FieldErrors } from '../../../../shared/field-errors/field-errors';
import { Icon } from '../../../../shared/icon/icon';
import { BoardEstimation } from '../board-estimation';
import {
  ItemCandidate,
  MAX_ITEMS,
  candidatesOf,
  cardsPerPerson,
  isPlainLine,
  keysOfSelection,
  roundsFor,
} from '../estimation-items';

export interface SetupDraft {
  title: string;
  mode: EstimationMode;
  deck: DeckChoice;
  custom: string;
  anonymous: boolean;
  placingSeconds: number;
  movingSeconds: number;
  markThreshold: number;
  rounds: number;
  roundSeconds: number;
  advanceWhenDone: boolean;
}

/** Defaults of a new session: three-minute phases, anonymous (E1 default true). */
export const SETUP_DEFAULTS: SetupDraft = {
  title: '',
  mode: EstimationMode.MAGIC,
  deck: 'FIBONACCI',
  custom: '',
  anonymous: true,
  placingSeconds: 180,
  movingSeconds: 300,
  markThreshold: 3,
  rounds: 3,
  roundSeconds: 120,
  advanceWhenDone: true,
};

let nextId = 0;

/**
 * Creates an estimation session (signed-in editors and owners): mode, deck, the cards from the
 * board (story cards and kanban cards; "take from selection" plus a checklist, at most 50),
 * the timing of the mode and anonymity (default on). Everything is fixed at creation and shown
 * in the lobby before anyone joins (E1). The titles are copies (plain text, one line); the
 * cards themselves are read live from the document later (E20).
 */
@Component({
  selector: 'drawboard-estimation-setup',
  imports: [FormField, FormRoot, FieldErrors, DeckPicker, Icon],
  templateUrl: './estimation-setup.html',
  host: { '(keydown.escape)': 'close()' },
})
export class EstimationSetup {
  private readonly estimation = inject(BoardEstimation);
  private readonly messages = inject(ErrorMessages);

  readonly engine = input.required<BoardEngine>();
  /** The session was created: the page opens its lobby. */
  readonly created = output<string>();
  readonly closed = output();

  protected readonly ids = `estimation-setup-${nextId++}`;
  protected readonly modes = EstimationMode;
  protected readonly maxItems = MAX_ITEMS;
  protected readonly busy = signal(false);
  protected readonly message = signal<string | undefined>(undefined);
  protected readonly candidates = signal<readonly ItemCandidate[]>([]);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  /** Cards already in an active session of this board (ref key -> its title): a hint only. */
  protected readonly busyCards = signal<ReadonlyMap<string, string>>(new Map());
  /** Rotation helper: how many people are expected (not sent; the start decides). */
  protected readonly expectedSeats = signal(5);
  protected readonly cardsWanted = signal(3);

  protected readonly pickedCount = computed(
    () => this.candidates().filter((c) => this.picked().has(c.key)).length,
  );
  protected readonly cardsEach = computed(() =>
    cardsPerPerson(this.draft().rounds, this.pickedCount(), this.expectedSeats()),
  );
  protected readonly itemsError = computed(() => {
    const n = this.pickedCount();
    if (n === 0) {
      return 'Pick at least one card.';
    }
    return n > MAX_ITEMS ? `At most ${MAX_ITEMS} cards per session.` : undefined;
  });

  protected readonly draft = signal<SetupDraft>({ ...SETUP_DEFAULTS });
  protected readonly setupForm = form(
    this.draft,
    (path) => {
      required(path.title, { message: 'Required.' });
      maxLength(path.title, 200, { message: 'At most 200 characters.' });
      validate(path.title, ({ value }) =>
        isPlainLine(value())
          ? undefined
          : { kind: 'control', message: 'One line of plain text, please.' },
      );
      validateCustomDeck(path.deck, path.custom);
      applyWhen(
        path,
        ({ valueOf }) => valueOf(path.mode) === EstimationMode.MAGIC,
        (p) => {
          seconds(p.placingSeconds, 30, 900);
          seconds(p.movingSeconds, 30, 1800);
          min(p.markThreshold, 3, { message: 'At least 3.' });
          max(p.markThreshold, 20, { message: 'At most 20.' });
        },
      );
      applyWhen(
        path,
        ({ valueOf }) => valueOf(path.mode) === EstimationMode.ROTATION,
        (p) => {
          min(p.rounds, 1, { message: 'At least 1.' });
          max(p.rounds, 10, { message: 'At most 10.' });
          seconds(p.roundSeconds, 30, 900);
        },
      );
    },
    { submission: { action: () => this.submit() } },
  );

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      const load = (): void => this.candidates.set(candidatesOf(engine.board));
      untracked(() => {
        load();
        // start with the selection, if there is one
        const selected = keysOfSelection(this.candidates(), engine.selection.list());
        this.picked.set(new Set(selected.slice(0, MAX_ITEMS)));
      });
      onCleanup(engine.board.observe(() => load()));
    });
    void this.estimation.busyCards().then((busy) => this.busyCards.set(busy));
  }

  protected isPicked(c: ItemCandidate): boolean {
    return this.picked().has(c.key);
  }

  @WithSpan('EstimationSetup.toggle')
  protected toggle(c: ItemCandidate): void {
    const next = new Set(this.picked());
    if (next.has(c.key)) {
      next.delete(c.key);
    } else {
      next.add(c.key);
    }
    this.picked.set(next);
  }

  @WithSpan('EstimationSetup.takeSelection')
  protected takeSelection(): void {
    const keys = keysOfSelection(this.candidates(), this.engine().selection.list());
    this.picked.set(new Set([...this.picked(), ...keys]));
  }

  @WithSpan('EstimationSetup.pickAll')
  protected pickAll(): void {
    this.picked.set(new Set(this.candidates().map((c) => c.key)));
  }

  @WithSpan('EstimationSetup.pickNone')
  protected pickNone(): void {
    this.picked.set(new Set());
  }

  @WithSpan('EstimationSetup.setExpectedSeats')
  protected setExpectedSeats(event: Event): void {
    const n = Math.round(Number((event.target as HTMLInputElement).value));
    this.expectedSeats.set(Number.isFinite(n) ? Math.min(30, Math.max(2, n)) : 2);
  }

  @WithSpan('EstimationSetup.setCardsWanted')
  protected setCardsWanted(event: Event): void {
    const n = Math.round(Number((event.target as HTMLInputElement).value));
    this.cardsWanted.set(Number.isFinite(n) && n > 0 ? n : 1);
  }

  /** "Each person sees N cards" -> rounds, within 1..min(10, participants) (E7). */
  @WithSpan('EstimationSetup.applyCards')
  protected applyCards(): void {
    const rounds = roundsFor(this.cardsWanted(), this.pickedCount(), this.expectedSeats());
    this.draft.update((d) => ({ ...d, rounds }));
  }

  @WithSpan('EstimationSetup.close')
  protected close(): void {
    this.closed.emit();
  }

  @WithSpan('EstimationSetup.submit')
  protected async submit(): Promise<undefined> {
    const d = this.draft();
    const values = d.deck === 'CUSTOM' ? parseCustomDeck(d.custom) : undefined;
    if (typeof values === 'string' || this.itemsError() || this.busy()) {
      return undefined;
    }
    const session: NewEstimationSession = {
      mode: d.mode,
      title: d.title.trim(),
      deck: values ? { kind: PokerDeckKind.CUSTOM, values } : { kind: d.deck },
      items: this.candidates()
        .filter((c) => this.picked().has(c.key))
        .slice(0, MAX_ITEMS)
        .map((c) => ({ ref: c.ref, title: c.title })),
      anonymous: d.anonymous,
      settings: settingsOf(d),
    };
    this.busy.set(true);
    this.message.set(undefined);
    try {
      const created = await this.estimation.create(session);
      this.created.emit(created.id);
    } catch (error) {
      this.message.set(
        error instanceof ApiError
          ? this.messages.text(error.problem)
          : 'The session could not be created.',
      );
    } finally {
      this.busy.set(false);
    }
    return undefined;
  }
}

/** The settings of the draft's mode only (the other mode's fields are refused, 400). */
export function settingsOf(d: SetupDraft): EstimationSettings {
  return d.mode === EstimationMode.MAGIC
    ? {
        placingSeconds: d.placingSeconds,
        movingSeconds: d.movingSeconds,
        markThreshold: d.markThreshold,
      }
    : { rounds: d.rounds, roundSeconds: d.roundSeconds, advanceWhenDone: d.advanceWhenDone };
}

function seconds(path: SchemaPath<number>, lowest: number, highest: number): void {
  min(path, lowest, { message: `At least ${lowest} seconds.` });
  max(path, highest, { message: `At most ${highest} seconds.` });
}
