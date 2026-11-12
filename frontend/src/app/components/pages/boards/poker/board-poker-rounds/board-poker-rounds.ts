import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { PokerRound } from '@apps/drawboard-api';

import { BoardEngine } from '../../../../../../board-engine/engine';
import { WithSpan } from '../../../../../util/tracing';
import { BoardPoker, isQuickRound } from '../board-poker';

/**
 * The "open rounds" indicator of a board: how many planning poker rounds are OPEN (listed by
 * the server, state OPEN) and a menu to jump to the story card of one and open its dialog, or
 * to open a quick round (no card). Editors and owners start a quick round from the same menu.
 * Opening the menu lists the rounds again (throttled): a quick round has no card that could
 * announce it, so this is how the others find it. With no open round the pill stays as a quiet
 * "Estimations" button; hidden only without poker access (VIEWER-link guests).
 */
@Component({
  selector: 'drawboard-board-poker-rounds',
  templateUrl: './board-poker-rounds.html',
  host: {
    '(keydown.escape)': 'menu.set(false)',
    '(document:pointerdown)': 'closeOnOutside($event)',
  },
})
export class BoardPokerRounds {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly poker = inject(BoardPoker);

  readonly engine = input<BoardEngine>();
  /** The board is read-only for this client (no quick round can be started then). */
  readonly readOnly = input(false);
  /** A round on a card was picked: the page opens the dialog of its story card. */
  readonly open = output<string>();
  /** A quick round was picked: the page opens the quick dialog of that round. */
  readonly openQuick = output<string>();
  /** "Start a quick round" was picked: the page opens the quick dialog's start form. */
  readonly startQuick = output();

  protected readonly menu = signal(false);
  protected readonly available = computed(() => this.poker.access() !== 'none');
  protected readonly rounds = computed(() => (this.available() ? this.poker.openRounds() : []));
  protected readonly canStart = computed(() => this.poker.access() === 'start' && !this.readOnly());

  protected quick(round: PokerRound): boolean {
    return isQuickRound(round);
  }

  /** A quick round can always be opened; a round on a card only while the card is here. */
  protected onBoard(round: PokerRound): boolean {
    const blockId = round.storyBlockId;
    return !blockId || (this.engine()?.board.hasBlock(blockId) ?? false);
  }

  @WithSpan('BoardPokerRounds.toggle')
  protected toggle(): void {
    this.menu.update((m) => !m);
    if (this.menu()) {
      this.poker.loadOpenRounds();
    }
  }

  @WithSpan('BoardPokerRounds.pick')
  protected pick(round: PokerRound): void {
    this.menu.set(false);
    const blockId = round.storyBlockId;
    if (!blockId) {
      this.openQuick.emit(round.id);
      return;
    }
    const engine = this.engine();
    if (engine && this.onBoard(round)) {
      engine.selection.set([blockId]);
      this.open.emit(blockId);
    }
  }

  @WithSpan('BoardPokerRounds.start')
  protected start(): void {
    this.menu.set(false);
    if (this.canStart()) {
      this.startQuick.emit();
    }
  }

  protected closeOnOutside(event: Event): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.menu.set(false);
    }
  }
}
