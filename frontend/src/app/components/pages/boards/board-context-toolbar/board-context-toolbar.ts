import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';

import {
  STICKY_COLORS,
  safeColor,
  FILL_COLORS,
  STROKE_COLORS,
  STROKE_WIDTHS,
  displayColor,
} from '@apps/drawboard-engine';
import {
  BoardEngine,
  SelectedTable,
  SelectionAnchor,
  SelectionKind,
  StyleInfo,
} from '../../../../../board-engine/engine';
import { WithSpan } from '../../../../util/tracing';
import { Theme } from '../../../../services/theme';
import { placeToolbar } from '../../../../util/toolbar-placement';
import { Icon } from '../../../shared/icon/icon';

type Field = 'color' | 'fill' | 'stroke' | 'strokeWidth';
type TableEdit = 'addRow' | 'addColumn' | 'removeRow' | 'removeColumn';

/** Half the widest toolbar: the bar stays this far from the window's edges. */
const HALF_WIDTH = 150;

const TRANSPARENT_PATTERN = 'repeating-conic-gradient(#cbd5e1 0 25%, #fff 0 50%) 50% / 8px 8px';

/**
 * The toolbar that floats above what is selected: colours (sticky, text), fill and stroke
 * (shapes, frames), stroke colour and width (pen strokes, connectors), "Remove frame, keep
 * contents" for frames, rows and columns for a table or a cell, duplicate and delete. The engine
 * reports where the selection is on screen (`selectionAnchorChanged`), so the bar follows
 * panning and zooming and is gone while the selection is dragged or edited.
 */
@Component({
  selector: 'drawboard-board-context-toolbar',
  imports: [Icon, NgTemplateOutlet],
  templateUrl: './board-context-toolbar.html',
  host: { '(keydown.escape)': 'closeMenu()' },
})
export class BoardContextToolbar {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly theme = inject(Theme);

  readonly engine = input<BoardEngine>();

  protected readonly widths = STROKE_WIDTHS;
  protected readonly fillColors = FILL_COLORS;
  protected readonly strokeColors = STROKE_COLORS;

  private readonly anchor = signal<SelectionAnchor>(null);
  private readonly viewport = signal({ w: 0, h: 0 });
  protected readonly info = signal<StyleInfo>({});
  protected readonly kind = signal<SelectionKind>('none');
  /** Something selected is a frame: "Remove frame, keep contents" applies. */
  protected readonly hasFrame = signal(false);
  /** One table or one of its cells is selected: rows and columns can be added and removed. */
  protected readonly table = signal<SelectedTable | undefined>(undefined);
  protected readonly menu = signal<Field | undefined>(undefined);

  /** Where the bar goes; undefined hides it (nothing selected, dragging, out of view). */
  protected readonly placement = computed(() => {
    const anchor = this.anchor();
    return anchor ? placeToolbar(anchor, this.viewport()) : undefined;
  });
  /** Horizontal position as CSS: centred on the selection, kept inside the window. */
  protected readonly left = computed(
    () => `clamp(${HALF_WIDTH}px, ${this.placement()?.x ?? 0}px, calc(100% - ${HALF_WIDTH}px))`,
  );
  /** Text takes the dark palette, notes the pastel one. */
  protected readonly colors = computed(() =>
    this.kind() === 'text' ? STROKE_COLORS : STICKY_COLORS,
  );

  constructor() {
    effect((onCleanup) => {
      const engine = this.engine();
      if (!engine) {
        return;
      }
      const setAnchor = (anchor: SelectionAnchor): void => {
        const el = this.host.nativeElement;
        this.viewport.set({ w: el.clientWidth, h: el.clientHeight });
        this.anchor.set(anchor);
      };
      const refresh = (): void => {
        this.info.set(engine.selectionStyle());
        this.kind.set(engine.selectionKind());
        this.hasFrame.set(engine.selectedFrames().length > 0);
        this.table.set(engine.selectedTable());
      };
      setAnchor(engine.selectionAnchor);
      refresh();
      const off = [
        engine.selectionAnchorChanged.on(setAnchor),
        engine.selectionStyleChanged.on(refresh),
        // a different selection starts without an open colour menu
        engine.selection.changed.on(() => this.menu.set(undefined)),
      ];
      onCleanup(() => off.forEach((o) => o()));
    });
  }

  protected has(field: Field): boolean {
    return this.info()[field] !== undefined;
  }

  protected current(field: Field): string | number | undefined {
    return this.info()[field];
  }

  protected swatch(color: string | number | undefined): string {
    // the value comes from block props, i.e. from other people: only plain hex reaches the style
    return !color || color === 'transparent' || color === 'none'
      ? TRANSPARENT_PATTERN
      : displayColor(safeColor(color, TRANSPARENT_PATTERN), this.theme.resolved());
  }

  @WithSpan('BoardContextToolbar.toggle', {
    attributes: (field: Field) => ({ 'style.field': field }),
  })
  protected toggle(field: Field): void {
    this.menu.update((open) => (open === field ? undefined : field));
  }

  @WithSpan('BoardContextToolbar.set', { attributes: (field: Field) => ({ 'style.field': field }) })
  protected set(field: Field, value: string | number): void {
    this.engine()?.setStyleForSelection({ [field]: value });
  }

  @WithSpan('BoardContextToolbar.duplicate')
  protected duplicate(): void {
    this.menu.set(undefined);
    this.engine()?.duplicateSelection();
  }

  @WithSpan('BoardContextToolbar.removeFrame')
  protected removeFrame(): void {
    this.menu.set(undefined);
    this.engine()?.removeSelectedFrames();
  }

  @WithSpan('BoardContextToolbar.tableEdit', {
    attributes: (edit: TableEdit) => ({ 'table.edit': edit }),
  })
  protected tableEdit(edit: TableEdit): void {
    const engine = this.engine();
    if (!engine) {
      return;
    }
    const run: Record<TableEdit, () => boolean> = {
      addRow: () => engine.tableAddRow(),
      addColumn: () => engine.tableAddColumn(),
      removeRow: () => engine.tableRemoveRow(),
      removeColumn: () => engine.tableRemoveColumn(),
    };
    run[edit]();
  }

  /** The selected cell's row can go (never the header row, never the last row). */
  protected canRemoveRow(t: SelectedTable): boolean {
    return t.rows > 1 && (t.row === undefined ? t.rows - 1 : t.row) >= 1;
  }

  @WithSpan('BoardContextToolbar.remove')
  protected remove(): void {
    this.menu.set(undefined);
    this.engine()?.deleteSelection();
  }

  protected closeMenu(): void {
    this.menu.set(undefined);
  }

  /** Complete class strings (Tailwind finds them): a swatch, ringed when it is the current one. */
  protected swatchClass(active: boolean): string {
    const base =
      'size-7 rounded-full ring-offset-2 ring-offset-(--color-st-surface) focus-visible:ring-2 focus-visible:ring-(--color-st-primary) border border-(--color-st-white-darker)';
    return active ? `${base} ring-2 ring-(--color-st-primary)` : base;
  }
}
