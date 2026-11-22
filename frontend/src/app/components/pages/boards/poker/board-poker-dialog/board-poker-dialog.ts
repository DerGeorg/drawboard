import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, FormRoot, form, maxLength, required, validate } from '@angular/forms/signals';
import { PokerDeckKind, PokerRound, PokerRoundState } from '@apps/drawboard-api';

import { STORY_ID, StoryModel, StoryState } from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../../board-engine/engine';
import { ErrorMessages } from '../../../../../services/error-messages';
import { ApiError } from '../../../../../util/api-error';
import { WithSpan } from '../../../../../util/tracing';
import { FieldErrors } from '../../../../shared/field-errors/field-errors';
import { Avatar } from '../../../../shared/avatar/avatar';
import {
  DeckPicker,
  DeckChoice,
  parseCustomDeck,
  validateCustomDeck,
} from '../../../../shared/deck-picker/deck-picker';
import { Icon } from '../../../../shared/icon/icon';
import { BoardPoker, isQuickRound } from '../board-poker';
import { PokerPoller } from '../poker-poller';

/** The stroke palette of the board, so a voter keeps one colour (taken from the name). */
const VOTER_COLORS = ['#ea580c', '#2563eb', '#16a34a', '#7c3aed', '#db2777', '#0891b2', '#ca8a04'];

const DECK_NAMES: Readonly<Record<string, string>> = {
  FIBONACCI: 'Fibonacci',
  TSHIRT: 'T-shirt',
  CUSTOM: 'Custom',
};

/** Votes that are no estimate (contract `PokerDeckKind`). */
const NO_ESTIMATE = new Set(['?', 'coffee']);

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

interface StartDraft {
  title: string;
  deck: DeckChoice;
  custom: string;
}

/**
 * How long the round to poll must stay unchanged before another one is fetched (M4 review
 * SHOULD 3): a document edit that flips the card's hint back and forth costs one request per
 * window, not one per flip. A token so that tests can shorten it.
 */
export const POKER_CANDIDATE_DEBOUNCE_MS = new InjectionToken<number>(
  'POKER_CANDIDATE_DEBOUNCE_MS',
  { providedIn: 'root', factory: () => 1000 },
);

type View = 'loading' | 'start' | 'idle' | 'open' | 'revealed' | 'cancelled';

/** The title a quick round starts with (the contract needs one; the editor may change it). */
export const QUICK_ROUND_TITLE = 'Quick round';

let nextId = 0;

/**
 * The planning poker dialog of ONE story card, or of a quick round without a card
 * (architecture 3.10, contract 2.0.0, S7.6).
 *
 * Binding: the round to show is the open round the server pairs with this card
 * (`round.storyBlockId`), else the card's own `pokerRoundId` hint (the announcement of a round
 * just started); a change to another round is debounced. It is shown only when the fetched
 * round's `storyBlockId` equals this card's id - anything else (a stale or forged id) is
 * ignored and its lease released. While shown and OPEN the round is
 * polled (one poller per round per tab, BoardPoker); closing the dialog stops it.
 *
 * Editors start a round (title, deck); COMMENTER and higher and guests on comment/edit links
 * vote; everyone sees who voted, never what. The facilitator (or the owner) reveals or cancels;
 * after the reveal an editor writes the chosen estimate into the card and clears
 * `pokerRoundId` - one ordinary document edit. Votes never enter the document.
 *
 * Quick mode (no `blockId`): the dialog shows the round `roundId` (picked in the open-rounds
 * menu) or, without one, the start form of a new quick round. It shows a round only when the
 * server says it has no card (`storyBlockId` absent) - the binding rule the other way round -
 * and it never touches the document: no announcement, no estimate, nothing to release. After
 * the reveal it shows the result and offers a new round (editors) and closing.
 */
@Component({
  selector: 'drawboard-board-poker-dialog',
  imports: [FormField, FormRoot, FieldErrors, Icon, Avatar, DeckPicker],
  templateUrl: './board-poker-dialog.html',
  styleUrl: './board-poker-dialog.css',
  host: { '(keydown.escape)': 'close()' },
})
export class BoardPokerDialog {
  private readonly messages = inject(ErrorMessages);
  protected readonly poker = inject(BoardPoker);
  private readonly debounceMs = inject(POKER_CANDIDATE_DEBOUNCE_MS);

  readonly engine = input.required<BoardEngine>();
  /**
   * card = the estimation dialog of a story card (`blockId` required), quick = a round without a
   * card. Explicit, so a card dialog that lost its block id fails instead of becoming a quick one
   * (Fable, "Quick poker rounds", SHOULD 2).
   */
  readonly mode = input.required<'card' | 'quick'>();
  /** The story card; card mode only. */
  readonly blockId = input<string>();
  /** Quick mode only: the quick round to show; absent to start one. */
  readonly roundId = input<string>();
  readonly closed = output();

  protected readonly ids = `poker-${nextId++}`;
  protected readonly state = PokerRoundState;

  /** Quick mode: no story card. */
  protected readonly quick = computed(() => this.mode() === 'quick');
  /** Quick mode: the round this dialog shows (the input, then the one just started). */
  private readonly quickRound = linkedSignal(() => this.roundId());
  private readonly model = computed(() => {
    const id = this.mode() === 'card' ? this.blockId() : undefined;
    return id === undefined
      ? undefined
      : new StoryModel(this.engine().board, id, () => this.engine().stopCapturing());
  });
  protected readonly story = signal<StoryState | undefined>(undefined);
  protected readonly readOnly = signal(false);
  protected readonly busy = signal(false);
  /** The last failure, as a sentence for the user. */
  protected readonly message = signal<string | undefined>(undefined);
  /** The estimate an editor picks after the reveal (default: the suggestion). */
  protected readonly chosen = signal<string | undefined>(undefined);

  /** The round this card points to: the server's pairing, else its own hint (quick: the round). */
  private readonly wanted = computed(() => {
    const id = this.blockId();
    return id === undefined
      ? this.quickRound()
      : (this.poker.openRoundOf(id)?.id ?? this.story()?.pokerRoundId ?? undefined);
  });
  /** `wanted`, changed at most once per debounce window (the first change goes through). */
  private readonly settled = signal<string | undefined>(undefined);
  /** Rounds the server showed to belong to another card: never polled again by this dialog. */
  private readonly foreign = signal<ReadonlySet<string>>(new Set());
  private readonly candidate = computed(() => {
    const id = this.settled();
    return id !== undefined && !this.foreign().has(id) ? id : undefined;
  });
  private readonly poller = signal<PokerPoller | undefined>(undefined);
  /** The round, only when the server says it belongs to this card (binding rule). */
  protected readonly round = computed<PokerRound | undefined>(() => {
    const round = this.poller()?.round();
    return round && this.belongs(round) ? round : undefined;
  });
  protected readonly myVote = computed(() => this.poller()?.myVote());
  protected readonly retrying = computed(() => this.poller()?.retrying() ?? false);

  protected readonly view = computed<View>(() => {
    const round = this.round();
    if (round) {
      return round.state === PokerRoundState.OPEN
        ? 'open'
        : round.state === PokerRoundState.REVEALED
          ? 'revealed'
          : 'cancelled';
    }
    const poller = this.poller();
    if (poller && !poller.end() && !poller.round()) {
      return 'loading';
    }
    return this.poker.access() === 'start' && !this.readOnly() ? 'start' : 'idle';
  });

  protected readonly canVote = computed(() => {
    const access = this.poker.access();
    return access === 'vote' || access === 'start';
  });
  protected readonly canFacilitate = computed(() => {
    const round = this.round();
    return !!round && this.poker.canFacilitate(round);
  });
  /** An editor may write the result while the card still points to this round (never quick). */
  protected readonly canWrite = computed(
    () =>
      !this.quick() &&
      !this.readOnly() &&
      !!this.round() &&
      this.story()?.pokerRoundId === this.round()?.id,
  );
  /** Quick mode: an editor may start the next round from a closed one. */
  protected readonly canStartAgain = computed(
    () => this.quick() && this.poker.access() === 'start' && !this.readOnly(),
  );
  /** Values that can become the card's estimate (no `?`, no coffee). */
  protected readonly estimates = computed(
    () => this.round()?.deck.values?.filter((v) => !NO_ESTIMATE.has(v)) ?? [],
  );
  /** "Fibonacci · 0, 1, 2, ..." under the title; empty while there is no round. */
  protected readonly deckLine = computed(() => {
    const deck = this.round()?.deck;
    return deck
      ? `Deck: ${DECK_NAMES[deck.kind] ?? deck.kind} · ${deck.values?.map((v) => this.display(v)).join(', ') ?? ''}`
      : '';
  });
  /** `prefers-reduced-motion`: the cards are swapped face up, not flipped. */
  protected readonly reducedMotion = signal(false);
  protected readonly votedCount = computed(
    () => this.round()?.participants.filter((p) => p.voted).length ?? 0,
  );
  protected readonly maxCount = computed(() =>
    Math.max(1, ...(this.round()?.result?.distribution.map((d) => d.count) ?? [])),
  );

  private readonly draft = signal<StartDraft>({ title: '', deck: 'FIBONACCI', custom: '' });
  protected readonly startForm = form(
    this.draft,
    (path) => {
      required(path.title, { message: 'Required.' });
      maxLength(path.title, 200, { message: 'At most 200 characters.' });
      validate(path.title, ({ value }) =>
        CONTROL_OR_FORMAT.test(value())
          ? { kind: 'control', message: 'No control characters.' }
          : undefined,
      );
      validateCustomDeck(path.deck, path.custom);
    },
    { submission: { action: () => this.start() } },
  );

  constructor() {
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (motion) {
      this.reducedMotion.set(motion.matches);
      const onChange = (event: MediaQueryListEvent): void => this.reducedMotion.set(event.matches);
      motion.addEventListener?.('change', onChange);
      inject(DestroyRef).onDestroy(() => motion.removeEventListener?.('change', onChange));
    }
    // a card dialog without its card shows nothing and closes
    effect(() => {
      if (this.mode() === 'card' && this.blockId() === undefined) {
        untracked(() => this.closed.emit());
      }
    });
    effect((onCleanup) => {
      const engine = this.engine();
      const id = this.blockId();
      const model = this.model();
      this.readOnly.set(engine.readOnly);
      if (id === undefined || model === undefined) {
        // quick mode: no card to read or watch
        this.story.set(undefined);
        untracked(() => {
          if (this.draft().title === '') {
            this.draft.update((d) => ({ ...d, title: QUICK_ROUND_TITLE }));
          }
        });
        const off = engine.readOnlyChanged.on((ro) => this.readOnly.set(ro));
        onCleanup(() => off());
        return;
      }
      const load = (): void => {
        if (!engine.board.hasBlock(id)) {
          this.closed.emit();
          return;
        }
        this.story.set(model.read());
      };
      load();
      untracked(() => {
        if (this.draft().title === '') {
          this.draft.update((d) => ({ ...d, title: model.read().title.slice(0, 200) }));
        }
      });
      const off = [
        engine.board.observe((change) => change.blocks.has(id) && load()),
        engine.readOnlyChanged.on((ro) => this.readOnly.set(ro)),
      ];
      onCleanup(() => off.forEach((o) => o()));
    });
    // leading + trailing debounce of the round to poll
    {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let appliedAt = Number.NEGATIVE_INFINITY;
      const apply = (): void => {
        clearTimeout(timer);
        timer = undefined;
        appliedAt = Date.now();
        this.settled.set(untracked(() => this.wanted()));
      };
      inject(DestroyRef).onDestroy(() => clearTimeout(timer));
      effect(() => {
        const next = this.wanted();
        untracked(() => {
          if (next === this.settled()) {
            clearTimeout(timer); // flipped back: nothing to fetch
            timer = undefined;
            return;
          }
          const wait = appliedAt + this.debounceMs - Date.now();
          // letting go of a round costs no request: only a new round waits for the window
          if (wait <= 0 || next === undefined) {
            apply();
          } else if (timer === undefined) {
            timer = setTimeout(apply, wait); // applies whatever is wanted when it fires
          }
        });
      });
    }
    // one shared poller per round; released when the round changes or the dialog closes
    effect((onCleanup) => {
      const roundId = this.candidate();
      if (!roundId || this.poker.access() === 'none') {
        this.poller.set(undefined);
        return;
      }
      const poller = untracked(() => this.poker.acquire(roundId));
      this.poller.set(poller);
      onCleanup(() => this.poker.release(roundId));
    });
    // after the reveal the suggestion is the default pick
    effect(() => {
      const round = this.round();
      if (round?.state === PokerRoundState.REVEALED && this.chosen() === undefined) {
        const suggestion = round.result?.suggestion;
        this.chosen.set(suggestion && !NO_ESTIMATE.has(suggestion) ? suggestion : undefined);
      }
    });
    // a forged id that points to another card's round: let go of it at once (the effect above
    // releases the lease; the poller itself may still serve another dialog, so no stop() here)
    effect(() => {
      const round = this.poller()?.round();
      if (round && !this.belongs(round)) {
        untracked(() => this.foreign.update((ids) => new Set(ids).add(round.id)));
      }
    });
  }

  /** Binding rule: a card's round names this card; in quick mode the round has no card. */
  private belongs(round: PokerRound): boolean {
    const id = this.blockId();
    return id === undefined ? isQuickRound(round) : round.storyBlockId === id;
  }

  protected display(value: string): string {
    return value === 'coffee' ? '☕' : value;
  }

  /** A voter's avatar colour: the same name always gets the same one. */
  protected colorOf(name: string): string {
    let hash = 0;
    for (const char of name) {
      hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
    }
    return VOTER_COLORS[hash % VOTER_COLORS.length] as string;
  }

  /** Text size of a card value: long values (XL, 13, custom words) shrink to fit the card. */
  protected valueClass(value: string, small: boolean): string {
    const length = Array.from(this.display(value)).length;
    if (small) {
      return length <= 2 ? 'text-lg' : 'text-xs';
    }
    return length <= 2 ? 'text-4xl' : length <= 4 ? 'text-2xl' : 'text-base';
  }

  /** "5 points" for a number, the plain value ("M") otherwise. */
  protected points(estimate: string): string {
    return /^\d+$/.test(estimate)
      ? `${estimate} ${estimate === '1' ? 'point' : 'points'}`
      : estimate;
  }

  protected width(count: number): string {
    return `${Math.round((count / this.maxCount()) * 100)}%`;
  }

  @WithSpan('BoardPokerDialog.start')
  protected async start(): Promise<undefined> {
    const d = this.draft();
    const values = d.deck === 'CUSTOM' ? parseCustomDeck(d.custom) : undefined;
    if (typeof values === 'string' || this.busy()) {
      return undefined;
    }
    await this.run(async () => {
      const deck = values ? { kind: PokerDeckKind.CUSTOM, values } : { kind: d.deck };
      const model = this.model();
      if (!model) {
        // a quick round: no card, nothing announced in the document
        const created = await this.poker.create({ title: d.title.trim(), deck });
        this.quickRound.set(created.id);
        return;
      }
      const created = await this.poker.create({
        storyBlockId: this.blockId(),
        title: d.title.trim(),
        deck,
      });
      // the announcement to everyone else: an id only, never a vote (S7.6)
      model.setPokerRound(created.id);
    });
    return undefined;
  }

  @WithSpan('BoardPokerDialog.vote')
  protected async vote(value: string): Promise<void> {
    const round = this.round();
    if (round) {
      await this.run(() => this.poker.vote(round.id, value));
    }
  }

  @WithSpan('BoardPokerDialog.reveal')
  protected async reveal(): Promise<void> {
    const round = this.round();
    if (round) {
      await this.run(async () => {
        await this.poker.reveal(round.id);
      });
    }
  }

  @WithSpan('BoardPokerDialog.cancel')
  protected async cancel(): Promise<void> {
    const round = this.round();
    if (round) {
      await this.run(async () => {
        await this.poker.cancel(round.id);
        // the canceller's client clears the card (contract cancelPokerRound; quick: no card)
        this.model()?.finishRound(round.id, null);
      });
    }
  }

  @WithSpan('BoardPokerDialog.pick')
  protected pick(value: string): void {
    this.chosen.set(value);
  }

  /** Writes the picked estimate into the card and clears `pokerRoundId` (S7.6 refined). */
  @WithSpan('BoardPokerDialog.writeEstimate')
  protected writeEstimate(): void {
    const round = this.round();
    if (round) {
      this.model()?.finishRound(round.id, this.chosen() ?? null);
    }
  }

  /** Quick mode: back to the start form for the next round (same title and deck). */
  @WithSpan('BoardPokerDialog.newRound')
  protected newRound(): void {
    if (this.canStartAgain()) {
      this.message.set(undefined);
      this.chosen.set(undefined);
      this.quickRound.set(undefined);
    }
  }

  /** Releases the card from a round that ended without an estimate. */
  @WithSpan('BoardPokerDialog.releaseCard')
  protected releaseCard(): void {
    const round = this.round();
    if (round) {
      this.model()?.finishRound(round.id, null);
    }
  }

  @WithSpan('BoardPokerDialog.close')
  protected close(): void {
    this.closed.emit();
  }

  /** Runs an operation with a busy flag and turns its failure into a message. */
  private async run(operation: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.message.set(undefined);
    try {
      await operation();
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy.set(false);
    }
  }

  private failed(error: unknown): void {
    if (!(error instanceof ApiError)) {
      this.message.set('Something went wrong.');
      return;
    }
    if (error.status === 401) {
      return; // the app's usual handling already ran (BoardPoker)
    }
    switch (error.code) {
      case 'PLANNING_ROUND_ALREADY_OPEN': {
        // the server's open round of THIS card: show it
        const open = error.problem.params?.['roundId'];
        if (open && STORY_ID.test(open)) {
          this.model()?.setPokerRound(open);
        }
        break;
      }
      case 'PLANNING_ROUND_CLOSED':
        this.poller()?.refresh();
        break;
    }
    this.message.set(
      error.status === 429
        ? 'Too many requests. Please wait a moment and try again.'
        : this.messages.text(error.problem),
    );
  }
}
