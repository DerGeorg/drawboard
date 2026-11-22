import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { Gif } from '@apps/drawboard-api';

import {
  STICKY_COLORS,
  displayColor,
  FILL_COLORS,
  STROKE_COLORS,
  STROKE_WIDTHS,
} from '@apps/drawboard-engine';
import { BoardEngine } from '../../../../../board-engine/engine';
import type { PluginBlockOption } from '../../../../../board-engine/plugins/plugin-host';
import { ToolId } from '../../../../../board-engine/tools/tool';
import { Theme } from '../../../../services/theme';
import { WithSpan } from '../../../../util/tracing';
import { EmojiPicker } from '../../../shared/emoji-picker/emoji-picker';
import { GifPicker } from '../../../shared/gif-picker/gif-picker';
import { Icon } from '../../../shared/icon/icon';
import { IconName } from '../../../shared/icon/icons';
import { ACCEPTED_EXTENSIONS, UPLOAD_LIMITS_TEXT } from '../board-uploads';

type GroupId =
  | 'select'
  | 'hand'
  | 'sticky'
  | 'text'
  | 'shapes'
  | 'frame'
  | 'table'
  | 'connector'
  | 'pen'
  | 'eraser'
  | 'emoji';
type FlyoutId = 'sticky' | 'shapes' | 'connector' | 'pen' | 'emoji';

interface ToolInfo {
  label: string;
  /** Shortcut shown in the tooltip (the engine handles the key); empty if the tool has none. */
  key: string;
  icon: IconName;
}

interface ToolGroup {
  id: GroupId;
  label: string;
  /** The tools the button stands for; `shapes` offers three, all others exactly one. */
  tools: readonly ToolId[];
  flyout?: FlyoutId;
}

const TOOL_INFO: Readonly<Record<ToolId, ToolInfo>> = {
  select: { label: 'Select', key: 'V', icon: 'select' },
  hand: { label: 'Hand', key: 'H', icon: 'hand' },
  sticky: { label: 'Sticky note', key: 'S', icon: 'sticky' },
  text: { label: 'Text', key: 'T', icon: 'text' },
  rect: { label: 'Rectangle', key: 'R', icon: 'rect' },
  ellipse: { label: 'Ellipse', key: 'O', icon: 'ellipse' },
  diamond: { label: 'Diamond', key: 'D', icon: 'diamond' },
  frame: { label: 'Frame', key: 'F', icon: 'frame' },
  table: { label: 'Table', key: 'G', icon: 'table' },
  connector: { label: 'Connector', key: 'C', icon: 'connector' },
  pen: { label: 'Pen', key: 'P', icon: 'pen' },
  eraser: { label: 'Eraser', key: 'E', icon: 'eraser' },
  emoji: { label: 'Emoji stamp', key: '', icon: 'emoji' },
};

const GROUPS: readonly ToolGroup[] = [
  { id: 'select', label: 'Select', tools: ['select'] },
  { id: 'hand', label: 'Hand', tools: ['hand'] },
  { id: 'sticky', label: 'Sticky note', tools: ['sticky'], flyout: 'sticky' },
  { id: 'text', label: 'Text', tools: ['text'] },
  { id: 'shapes', label: 'Shapes', tools: ['rect', 'ellipse', 'diamond'], flyout: 'shapes' },
  { id: 'frame', label: 'Frame', tools: ['frame'] },
  { id: 'table', label: 'Table', tools: ['table'] },
  { id: 'connector', label: 'Connector', tools: ['connector'], flyout: 'connector' },
  { id: 'pen', label: 'Pen', tools: ['pen'], flyout: 'pen' },
  { id: 'eraser', label: 'Eraser', tools: ['eraser'] },
  { id: 'emoji', label: 'Emoji stamp', tools: ['emoji'], flyout: 'emoji' },
];

const READ_ONLY_GROUPS: ReadonlySet<GroupId> = new Set(['select', 'hand']);

/**
 * The floating tool column on the left of the canvas: one button per tool (shapes are one button
 * with a flyout), flyouts for the sticky colours, the shapes and the pen, undo and redo at the
 * bottom. State comes from the engine's callbacks; every action goes back through the engine.
 */
@Component({
  selector: 'drawboard-board-toolbar',
  imports: [Icon, EmojiPicker, GifPicker],
  templateUrl: './board-toolbar.html',
  host: {
    '(document:pointerdown)': 'closeFlyoutOnOutside($event)',
    '(keydown.escape)': 'closeFlyout()',
    '(keydown)': 'moveFocus($event)',
  },
})
export class BoardToolbar {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly theme = inject(Theme);

  readonly engine = input<BoardEngine>();
  readonly readOnly = input(false);
  /** Signed-in editors and owners only (never guests, S1.9): shows the upload button. */
  readonly canUpload = input(false);
  /** Files picked with the upload button. */
  readonly upload = output<File[]>();
  /** The diagram button: the page adds a Mermaid block and opens its source. */
  readonly diagram = output();
  /** The kanban button: the page adds a kanban block. */
  readonly kanban = output();
  /** The story card button: the page adds a story card and opens it. */
  readonly story = output();
  /**
   * Signed-in editors on an instance with GIFs (frontend switch and backend key, G3) - never
   * guests (G5): shows the GIF button.
   */
  readonly gifsAvailable = input(false);
  /** The board's id: the key of the viewer's "Load" consent in the GIF picker. */
  readonly boardKey = input('');
  /** A GIF was picked in the GIF picker: the page adds a block. */
  readonly gif = output<Gif>();
  /** Block types of the enabled plugins (sandboxed, S3.2). */
  readonly pluginBlocks = input<readonly PluginBlockOption[]>([]);
  /** A plugin block type was picked: the page adds one. */
  readonly pluginBlock = output<PluginBlockOption>();

  protected readonly pluginMenu = signal(false);
  protected readonly gifMenu = signal(false);

  protected readonly accept = ACCEPTED_EXTENSIONS.join(',');
  protected readonly uploadLimits = UPLOAD_LIMITS_TEXT;

  protected readonly stickyColors = STICKY_COLORS;
  protected readonly strokeColors = STROKE_COLORS;
  protected readonly fillColors = FILL_COLORS;
  protected readonly strokeWidths = STROKE_WIDTHS;
  protected readonly info = TOOL_INFO;
  protected readonly shapeTools: readonly ToolId[] = ['rect', 'ellipse', 'diamond'];

  protected readonly tool = signal<ToolId>('select');
  protected readonly canUndo = signal(false);
  protected readonly canRedo = signal(false);
  /** The shape the shapes button creates (the one chosen last). */
  protected readonly shapeTool = signal<ToolId>('rect');
  protected readonly flyout = signal<FlyoutId | undefined>(undefined);
  protected readonly stickyColor = signal<string>(STICKY_COLORS[0]);
  protected readonly penColor = signal<string>(STROKE_COLORS[0]);
  protected readonly penSize = signal<number>(STROKE_WIDTHS[2]);
  protected readonly fillColor = signal<string>('#ffffff');

  protected readonly groups = computed(() =>
    this.readOnly() ? GROUPS.filter((g) => READ_ONLY_GROUPS.has(g.id)) : GROUPS,
  );

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      if (!engine) {
        return;
      }
      const syncStyle = (): void => {
        this.stickyColor.set(engine.drawStyle.sticky);
        this.penColor.set(engine.drawStyle.color);
        this.penSize.set(engine.drawStyle.size);
        this.fillColor.set(engine.drawStyle.fill);
      };
      const syncTool = (t: ToolId): void => {
        this.tool.set(t);
        if (this.shapeTools.includes(t)) {
          this.shapeTool.set(t);
        }
        // a flyout belongs to its tool: it goes away when the tool is left
        const open = this.flyout();
        if (open && !this.groupOf(open)?.tools.includes(t)) {
          this.flyout.set(undefined);
        }
      };
      syncTool(engine.tool);
      syncStyle();
      this.canUndo.set(engine.historyState.canUndo);
      this.canRedo.set(engine.historyState.canRedo);
      const off = [
        engine.toolChanged.on(syncTool),
        engine.drawStyleChanged.on(syncStyle),
        engine.historyChanged.on((h) => {
          this.canUndo.set(h.canUndo);
          this.canRedo.set(h.canRedo);
        }),
      ];
      onCleanup(() => off.forEach((o) => o()));
    });
  }

  /** The tool a group's button currently stands for. */
  protected toolOf(group: ToolGroup): ToolId {
    return group.id === 'shapes' ? this.shapeTool() : (group.tools[0] as ToolId);
  }

  protected isActive(group: ToolGroup): boolean {
    return group.tools.includes(this.tool());
  }

  protected tooltip(group: ToolGroup): string {
    const t = TOOL_INFO[this.toolOf(group)];
    const name = group.id === 'shapes' ? group.label : t.label;
    return t.key ? `${name} (${t.key})` : name;
  }

  /** Selects the group's tool; a group with a flyout opens or closes it on every click. */
  @WithSpan('BoardToolbar.pick', { attributes: (group: ToolGroup) => ({ 'tool.id': group.id }) })
  protected pick(group: ToolGroup): void {
    const engine = this.engine();
    if (!engine) {
      return;
    }
    if (!this.isActive(group)) {
      engine.setTool(this.toolOf(group));
    }
    this.gifMenu.set(false);
    this.flyout.set(group.flyout && this.flyout() !== group.flyout ? group.flyout : undefined);
  }

  @WithSpan('BoardToolbar.pickShape', { attributes: (id: ToolId) => ({ 'tool.id': id }) })
  protected pickShape(id: ToolId): void {
    this.engine()?.setTool(id);
    this.flyout.set(undefined);
  }

  /** An emoji was picked: it is the stamp from now on, and the stamp tool is active. */
  @WithSpan('BoardToolbar.pickEmoji')
  protected pickEmoji(emoji: string): void {
    const engine = this.engine();
    engine?.setDrawStyle({ emoji });
    engine?.setTool('emoji');
    this.flyout.set(undefined);
  }

  @WithSpan('BoardToolbar.pickStickyColor')
  protected pickStickyColor(color: string): void {
    this.engine()?.setDrawStyle({ sticky: color });
  }

  @WithSpan('BoardToolbar.pickFill')
  protected pickFill(fill: string): void {
    this.engine()?.setDrawStyle({ fill });
  }

  /** Pattern for the "no fill" swatch. */
  protected readonly transparentPattern =
    'repeating-conic-gradient(#cbd5e1 0 25%, #fff 0 50%) 50% / 8px 8px';

  @WithSpan('BoardToolbar.pickPenColor')
  protected pickPenColor(color: string): void {
    this.engine()?.setDrawStyle({ color });
  }

  @WithSpan('BoardToolbar.pickPenSize')
  protected pickPenSize(size: number): void {
    this.engine()?.setDrawStyle({ size });
  }

  /** The colour a swatch shows: the stored colour as it is drawn in the current theme. */
  protected shade(color: string): string {
    return displayColor(color, this.theme.resolved());
  }

  /** Complete class strings (Tailwind finds them): a colour swatch, ringed when it is the current one. */
  protected swatchClass(active: boolean, shape: string): string {
    const base =
      'size-8 ring-offset-2 ring-offset-(--color-st-surface) focus-visible:ring-2 focus-visible:ring-(--color-st-primary) ';
    return base + shape + (active ? ' ring-2 ring-(--color-st-primary)' : '');
  }

  @WithSpan('BoardToolbar.togglePlugins')
  protected togglePlugins(): void {
    this.pluginMenu.update((open) => !open);
  }

  @WithSpan('BoardToolbar.addPluginBlock', {
    attributes: (o: PluginBlockOption) => ({ 'plugin.id': o.pluginId }),
  })
  protected addPluginBlock(option: PluginBlockOption): void {
    this.pluginMenu.set(false);
    this.pluginBlock.emit(option);
  }

  @WithSpan('BoardToolbar.toggleGifs')
  protected toggleGifs(): void {
    this.flyout.set(undefined);
    this.gifMenu.update((open) => !open);
  }

  @WithSpan('BoardToolbar.pickGif')
  protected pickGif(gif: Gif): void {
    this.gifMenu.set(false);
    this.gif.emit(gif);
  }

  @WithSpan('BoardToolbar.addDiagram')
  protected addDiagram(): void {
    this.diagram.emit();
  }

  @WithSpan('BoardToolbar.addKanban')
  protected addKanban(): void {
    this.kanban.emit();
  }

  @WithSpan('BoardToolbar.addStory')
  protected addStory(): void {
    this.story.emit();
  }

  @WithSpan('BoardToolbar.picked')
  protected picked(picker: HTMLInputElement): void {
    const files = Array.from(picker.files ?? []);
    picker.value = ''; // the same file can be picked again
    if (files.length > 0) {
      this.upload.emit(files);
    }
  }

  @WithSpan('BoardToolbar.closeFlyout')
  protected closeFlyout(): void {
    this.flyout.set(undefined);
    this.pluginMenu.set(false);
    this.gifMenu.set(false);
  }

  protected closeFlyoutOnOutside(event: Event): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.flyout.set(undefined);
      this.pluginMenu.set(false);
      this.gifMenu.set(false);
    }
  }

  /** Up/Down move between the tool buttons (the toolbar is one tab stop group per button). */
  protected moveFocus(event: KeyboardEvent): void {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) {
      return;
    }
    const buttons = Array.from(
      this.host.nativeElement.querySelectorAll<HTMLButtonElement>(
        'button[data-bar]:not(:disabled)',
      ),
    );
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    const next = buttons[(at + step + buttons.length) % buttons.length];
    if (at >= 0 && next) {
      event.preventDefault();
      next.focus();
    }
  }

  private groupOf(flyout: FlyoutId): ToolGroup | undefined {
    return GROUPS.find((g) => g.flyout === flyout);
  }
}
