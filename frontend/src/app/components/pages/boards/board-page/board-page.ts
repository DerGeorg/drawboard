import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { BoardRole, BoardsService } from '@apps/drawboard-api';

import {
  MAX_MERMAID_BYTES,
  MERMAID_TYPE,
  SAMPLE_DIAGRAM,
  byteLength,
} from '../../../../../board-engine/blocks/mermaid';
import { KANBAN_CARD_ACTION } from '../../../../../board-engine/blocks/kanban';
import { STORY_ESTIMATE_ACTION } from '../../../../../board-engine/blocks/story';
import { KANBAN_TYPE, newKanbanProps } from '../../../../../board-engine/blocks/kanban-model';
import { STORY_TYPE, newStoryProps } from '../../../../../board-engine/blocks/story-model';
import { mermaidRenderer } from '../../../../../board-engine/diagrams/mermaid-renderer';
import { pdfRenderers } from '../../../../../board-engine/files/pdf-view';
import type { Point } from '../../../../../board-engine/model/types';
import { Auth } from '../../../../services/auth';
import { Toasts } from '../../../../services/toasts';
import type { PluginBlockOption } from '../../../../../board-engine/plugins/plugin-host';
import { Modal } from '../../../shared/modal/modal';
import { LoadError } from '../../../shared/load-error/load-error';
import { WithSpan } from '../../../../util/tracing';
import { BoardCanvas, CanvasFiles } from '../board-canvas/board-canvas';
import { BoardCollab } from '../board-collab';
import { BoardDiagramEditor } from '../board-diagram-editor/board-diagram-editor';
import { BoardFollow } from '../board-follow';
import { BoardFollowBar } from '../board-follow-bar/board-follow-bar';
import { BoardKanbanCard } from '../board-kanban-card/board-kanban-card';
import { BoardStoryEditor } from '../board-story-editor/board-story-editor';
import { BoardPoker } from '../poker/board-poker';
import { BoardPokerDialog } from '../poker/board-poker-dialog/board-poker-dialog';
import { BoardPokerRounds } from '../poker/board-poker-rounds/board-poker-rounds';
import { BoardFiles } from '../board-files';
import { BoardPlugins } from '../board-plugins';
import { BoardUploadPanel } from '../board-upload-panel/board-upload-panel';
import { BoardUploads } from '../board-uploads';
import { BoardContextToolbar } from '../board-context-toolbar/board-context-toolbar';
import { BoardTextEmoji } from '../board-text-emoji/board-text-emoji';
import { BoardParticipants } from '../board-participants/board-participants';
import { BoardTitleBar } from '../board-title-bar/board-title-bar';
import { BoardToolbar } from '../board-toolbar/board-toolbar';
import { BoardZoom } from '../board-zoom/board-zoom';
import { ShareDialog } from '../share-dialog/share-dialog';
import { GuestMadeWith } from '../../guests/guest-made-with/guest-made-with';

/** What the side panel on the right shows (one at a time). */
type SidePanel =
  | { kind: 'diagram'; blockId: string }
  | { kind: 'story'; blockId: string }
  | { kind: 'poker'; blockId: string }
  | { kind: 'quick-poker'; roundId: string | undefined }
  | { kind: 'card'; blockId: string; cardId: string };

/**
 * /boards/:boardId - the editor: a canvas that fills the window with all chrome floating over it
 * (title pill top left, participants and Share top right, tool column on the left, zoom at the
 * bottom right). The drawing is synchronised live through BoardCollab (one connection
 * per open board, opened once the metadata loaded); a board that does not exist answers 404 and
 * ApiErrorHandler shows the not-found page.
 */
@Component({
  selector: 'drawboard-board-page',
  imports: [
    RouterLink,
    LoadError,
    BoardCanvas,
    BoardParticipants,
    BoardFollowBar,
    ShareDialog,
    BoardContextToolbar,
    BoardTextEmoji,
    BoardTitleBar,
    BoardToolbar,
    BoardZoom,
    BoardUploadPanel,
    BoardDiagramEditor,
    BoardKanbanCard,
    BoardStoryEditor,
    BoardPokerDialog,
    BoardPokerRounds,
    Modal,
    GuestMadeWith,
  ],
  providers: [BoardCollab, BoardFiles, BoardUploads, BoardPlugins, BoardPoker, BoardFollow],
  templateUrl: './board-page.html',
  // the editor fills the window (the app shell drops header and footer on this route)
  host: { class: 'relative block h-dvh overflow-hidden' },
})
export class BoardPage {
  private readonly boardsApi = inject(BoardsService);
  protected readonly collab = inject(BoardCollab);
  private readonly files = inject(BoardFiles);
  protected readonly uploads = inject(BoardUploads);
  protected readonly plugins = inject(BoardPlugins);
  private readonly poker = inject(BoardPoker);
  /** Following a participant, presenting ("bring everyone to me"). */
  protected readonly follow = inject(BoardFollow);
  private readonly auth = inject(Auth);
  private readonly toasts = inject(Toasts);
  /**
   * Host services of the built-in blocks: signed file URLs of this board, and pdf.js (its own
   * lazy chunk, assets copied to /pdfjs/ by angular.json) for PDFs and converted documents.
   */
  private readonly pdf = pdfRenderers({ assetBase: '/pdfjs/' });
  protected readonly services = {
    files: this.files,
    fileRenderers: this.pdf,
    // Mermaid + DOMPurify: their own lazy chunk, strict and sanitised (S5.1)
    diagrams: mermaidRenderer(),
    // which story cards have an open planning poker round (the server's pairing)
    estimates: this.poker,
  };
  /** The side panel on the right: a diagram's source, a kanban card, a story card. */
  protected readonly panel = signal<SidePanel | undefined>(undefined);
  protected readonly guest = this.auth.guest;
  protected readonly selfName = computed(
    () => this.auth.guest()?.name ?? this.auth.user()?.displayName,
  );
  /** The back arrow: the library, or for a guest of a folder link the folder's board list. */
  protected readonly backLink = computed(() => {
    const guest = this.auth.guest();
    if (!guest) {
      return '/boards';
    }
    return guest.kind === 'FOLDER' ? `/s/f/${guest.id}` : null;
  });
  protected readonly shareOpen = signal(false);

  /** Route parameter (withComponentInputBinding). */
  readonly boardId = input.required<string>();

  protected readonly board = rxResource({
    params: () => ({ boardId: this.boardId() }),
    stream: ({ params }) => this.boardsApi.getBoard(params),
  });

  /** The loaded board; undefined while loading or after a failure (value() would throw then). */
  protected readonly loaded = computed(() =>
    this.board.hasValue() ? this.board.value() : undefined,
  );

  protected readonly doc = this.collab.doc;
  private readonly canvas = viewChild(BoardCanvas);
  protected readonly engine = computed(() => this.canvas()?.engine());

  /**
   * The server ended the live session for good (close code 4403/4404: membership removed, link
   * revoked or expired, board trashed). Nothing drawn now would be saved, so the page says so.
   */
  protected readonly denied = computed(() => this.collab.state()?.status === 'denied');

  /** Viewers and commenters look but do not draw; nobody draws once access ended. */
  protected readonly readOnly = computed(() => {
    const role = this.board.value()?.role;
    return role === BoardRole.VIEWER || role === BoardRole.COMMENTER || this.denied();
  });

  /** Uploads: editors and owners who are signed in - never guests (S1.9, S4.1). */
  protected readonly canUpload = computed(
    () => this.board.hasValue() && !this.readOnly() && this.guest() === null,
  );

  constructor() {
    // the one pdf.js worker of this board goes with the page
    inject(DestroyRef).onDestroy(() => this.pdf.destroy());
    // before the canvas exists: file blocks ask for their files as soon as they mount
    effect(() => {
      const boardId = this.boardId();
      untracked(() => {
        this.files.open(boardId);
        this.uploads.open(boardId);
      });
    });
    // connect once the board is known to exist and be visible (BoardCollab ignores repeats)
    effect(() => {
      if (this.board.hasValue()) {
        const boardId = this.boardId();
        untracked(() => this.collab.connect(boardId));
      }
    });
    effect(() => {
      const engine = this.engine();
      untracked(() => {
        this.collab.bind(engine);
        this.uploads.bind(engine);
        this.panel.set(undefined); // a new engine: a new document
        this.plugins.attach(engine, this.loaded());
      });
    });
    // follow and present: my role decides whether I may summon; the engine's camera follows
    effect(() => {
      const board = this.loaded();
      if (board) {
        untracked(() => this.follow.open(board.role));
      }
    });
    effect((onCleanup) => {
      const engine = this.engine();
      if (engine) {
        onCleanup(untracked(() => this.follow.attach(engine)));
      }
    });
    // planning poker: the open rounds of this board, refreshed when a card announces a round
    effect(() => {
      const board = this.loaded();
      if (board) {
        untracked(() => this.poker.open(board.id, board.role));
      }
    });
    effect(() => {
      const doc = this.doc();
      untracked(() => this.poker.watch(doc));
    });
    // role or title changed (reload after a share change): plugins see it in their next init
    effect(() => {
      const board = this.loaded();
      untracked(() => this.plugins.update(board));
    });
    // double-click on a diagram opens its source; a click on a kanban card its panel
    effect((onCleanup) => {
      const engine = this.engine();
      if (engine) {
        const off = [
          engine.blockOpened.on((id) => this.openDiagram(id)),
          engine.blockRequested.on((request) => {
            if (request.action === KANBAN_CARD_ACTION && request.itemId) {
              this.panel.set({ kind: 'card', blockId: request.blockId, cardId: request.itemId });
            } else if (request.action === STORY_ESTIMATE_ACTION) {
              this.openPoker(request.blockId);
            }
          }),
          // copy and paste: too large, left out, refused
          engine.clipboardNotice.on((message) => this.toasts.error(message)),
        ];
        onCleanup(() => off.forEach((o) => o()));
      }
    });
  }

  @WithSpan('BoardPage.addDiagram')
  protected addDiagram(source = SAMPLE_DIAGRAM, at?: Point): void {
    const engine = this.engine();
    if (!engine || byteLength(source) > MAX_MERMAID_BYTES) {
      return;
    }
    const id = engine.insertBlock({
      type: MERMAID_TYPE,
      at: at ?? engine.visibleCenter(),
      text: source,
    });
    if (id) {
      this.panel.set({ kind: 'diagram', blockId: id });
    }
  }

  @WithSpan('BoardPage.addStory')
  protected addStory(): void {
    const engine = this.engine();
    const id = engine?.insertBlock({
      type: STORY_TYPE,
      at: engine.visibleCenter(),
      props: newStoryProps(),
      text: 'New story',
    });
    if (id) {
      this.panel.set({ kind: 'story', blockId: id });
    }
  }

  protected readonly pokerAvailable = computed(() => this.poker.access() !== 'none');

  /** The planning poker dialog of a story card (VIEWER-link guests never get one). */
  @WithSpan('BoardPage.openPoker')
  protected openPoker(blockId: string): void {
    if (this.poker.access() !== 'none') {
      this.panel.set({ kind: 'poker', blockId });
    }
  }

  /** The planning poker dialog of a quick round (no story card); VIEWER-link guests never. */
  @WithSpan('BoardPage.openQuickPoker')
  protected openQuickPoker(roundId: string): void {
    if (this.poker.access() !== 'none') {
      this.panel.set({ kind: 'quick-poker', roundId });
    }
  }

  /** The start form of a new quick round: signed-in editors and owners only, never guests. */
  @WithSpan('BoardPage.startQuickPoker')
  protected startQuickPoker(): void {
    if (this.poker.access() === 'start' && !this.readOnly()) {
      this.panel.set({ kind: 'quick-poker', roundId: undefined });
    }
  }

  @WithSpan('BoardPage.addKanban')
  protected addKanban(): void {
    const engine = this.engine();
    engine?.insertBlock({ type: KANBAN_TYPE, at: engine.visibleCenter(), props: newKanbanProps() });
  }

  @WithSpan('BoardPage.addPluginBlock', {
    attributes: (o: PluginBlockOption) => ({ 'plugin.id': o.pluginId }),
  })
  protected addPluginBlock(option: PluginBlockOption): void {
    const engine = this.engine();
    engine?.insertBlock({
      type: option.type,
      at: engine.visibleCenter(),
      size: { w: option.w, h: option.h },
    });
  }

  /** "Ignore" on the presenting bar: the presenter's summons are ignored for the session. */
  @WithSpan('BoardPage.ignorePresenter')
  protected ignorePresenter(userId: string): void {
    const peer = this.collab.peers().find((p) => p.userId === userId);
    if (peer) {
      this.follow.ignore(peer);
    }
  }

  @WithSpan('BoardPage.answerLink')
  protected answerLink(open: boolean): void {
    this.plugins.linkPrompt()?.answer(open);
  }

  private openDiagram(id: string): void {
    const type = this.engine()?.board.getBlock(id)?.type;
    if (type === MERMAID_TYPE) {
      this.panel.set({ kind: 'diagram', blockId: id });
    } else if (type === STORY_TYPE) {
      this.panel.set({ kind: 'story', blockId: id });
    }
  }

  /** `.mmd` files dropped on the board become diagrams (architecture 3.7). */
  private async importDiagrams(files: File[], at: Point | undefined): Promise<void> {
    for (const [index, file] of files.entries()) {
      if (file.size > MAX_MERMAID_BYTES) {
        this.toasts.error(`${file.name} is larger than 50 KB and was not added.`);
        continue;
      }
      const offset = index * 24;
      this.addDiagram(await file.text(), at && { x: at.x + offset, y: at.y + offset });
    }
  }

  @WithSpan('BoardPage.upload')
  protected upload(files: File[]): void {
    this.uploads.upload(files);
  }

  @WithSpan('BoardPage.dropped')
  protected dropped(event: CanvasFiles): void {
    const diagrams = event.files.filter((f) => f.name.toLowerCase().endsWith('.mmd'));
    const others = event.files.filter((f) => !diagrams.includes(f));
    if (others.length > 0) {
      this.uploads.upload(others, event.at);
    }
    void this.importDiagrams(diagrams, event.at);
  }
}
