import { Camera, worldToScreen } from '../camera';
import { BoardDoc } from '../model/board-doc';
import { Rect } from '../model/types';
import { PeerPresence, safeColor } from '../presence';
import { itemBounds } from '../scene';
import { HANDLES, handlePosition } from '../tools/resize';
import { OverlayHints } from '../tools/tool';
import { unionRects } from '../util/geometry';
import { strokePath } from './stroke-path';

const NS = 'http://www.w3.org/2000/svg';
export const HANDLE_SIZE = 8;
export const SELECTION_COLOR = 'var(--be-selection, #2563eb)';

export interface OverlayState {
  camera: Camera;
  selection: string[];
  hints: OverlayHints;
  peers: PeerPresence[];
  /** Resize handles only appear for an editable single block. */
  canResize: boolean;
}

/** Screen-space SVG above the world: selection box, handles, marquee, remote cursors. */
export class Overlay {
  readonly svg: SVGSVGElement;

  constructor(
    private readonly doc: Document,
    private readonly board: BoardDoc,
  ) {
    this.svg = doc.createElementNS(NS, 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    this.svg.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden';
  }

  /** The block whose handles are shown (single editable selection), else undefined. */
  static handleTarget(
    board: BoardDoc,
    selection: string[],
    canResize: boolean,
  ): string | undefined {
    const id = selection.length === 1 ? selection[0] : undefined;
    const b = id ? board.getBlock(id) : undefined;
    return canResize && b && !b.locked ? id : undefined;
  }

  render(s: OverlayState): void {
    const parts: SVGElement[] = [];
    const toScreen = (r: Rect): Rect => {
      const p = worldToScreen(s.camera, r);
      return { x: p.x, y: p.y, w: r.w * s.camera.zoom, h: r.h * s.camera.zoom };
    };

    for (const peer of s.peers) {
      const color = safeColor(peer.color);
      for (const id of peer.selection) {
        const r = itemBounds(this.board, id);
        if (r) {
          parts.push(
            this.rect(toScreen(r), {
              stroke: color,
              'stroke-width': '2',
              fill: 'none',
              'stroke-dasharray': '4 3',
            }),
          );
        }
      }
    }

    const bounds = s.selection.flatMap((id) => itemBounds(this.board, id) ?? []);
    for (const r of bounds) {
      parts.push(
        this.rect(toScreen(r), { stroke: SELECTION_COLOR, 'stroke-width': '1.5', fill: 'none' }),
      );
    }
    const target = Overlay.handleTarget(this.board, s.selection, s.canResize);
    const box = target ? itemBounds(this.board, target) : undefined;
    if (box) {
      const sr = toScreen(box);
      for (const h of HANDLES) {
        const p = handlePosition(sr, h);
        parts.push(
          this.rect(
            { x: p.x - HANDLE_SIZE / 2, y: p.y - HANDLE_SIZE / 2, w: HANDLE_SIZE, h: HANDLE_SIZE },
            { stroke: SELECTION_COLOR, 'stroke-width': '1.5', fill: '#fff' },
            h,
          ),
        );
      }
    } else if (bounds.length > 1) {
      const u = unionRects(bounds);
      if (u) {
        parts.push(
          this.rect(toScreen(u), {
            stroke: SELECTION_COLOR,
            'stroke-width': '1',
            fill: 'none',
            'stroke-dasharray': '5 4',
          }),
        );
      }
    }

    if (s.hints.snapBlock) {
      const r = itemBounds(this.board, s.hints.snapBlock);
      if (r) {
        parts.push(
          this.rect(toScreen(r), { stroke: SELECTION_COLOR, 'stroke-width': '3', fill: 'none' }),
        );
      }
    }
    if (s.hints.ghostLine) {
      const a = worldToScreen(s.camera, s.hints.ghostLine.from);
      const b = worldToScreen(s.camera, s.hints.ghostLine.to);
      const line = this.doc.createElementNS(NS, 'path');
      line.setAttribute('d', `M${a.x} ${a.y} L${b.x} ${b.y}`);
      line.setAttribute('stroke', SELECTION_COLOR);
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6 4');
      line.setAttribute('fill', 'none');
      parts.push(line);
    }
    const live = s.hints.liveStroke;
    if (live) {
      const pts: number[] = [];
      for (let i = 0; i + 1 < live.points.length; i += 3) {
        const p = worldToScreen(s.camera, { x: live.points[i] ?? 0, y: live.points[i + 1] ?? 0 });
        pts.push(p.x, p.y, live.points[i + 2] ?? 0.5);
      }
      const path = this.doc.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        strokePath({
          id: 'live',
          points: pts,
          style: { color: live.color, size: live.size * s.camera.zoom },
        }),
      );
      path.setAttribute('fill', live.color);
      parts.push(path);
    }
    if (s.hints.marquee) {
      const r = toScreen(s.hints.marquee);
      parts.push(
        this.rect(r, { stroke: SELECTION_COLOR, 'stroke-width': '1', fill: 'rgba(37,99,235,.08)' }),
      );
    }

    for (const peer of s.peers) {
      if (peer.cursor) {
        parts.push(
          this.cursor(worldToScreen(s.camera, peer.cursor), safeColor(peer.color), peer.name),
        );
      }
    }
    this.svg.replaceChildren(...parts);
  }

  private rect(r: Rect, attrs: Record<string, string>, handle?: string): SVGRectElement {
    const el = this.doc.createElementNS(NS, 'rect');
    el.setAttribute('x', String(r.x));
    el.setAttribute('y', String(r.y));
    el.setAttribute('width', String(Math.max(0, r.w)));
    el.setAttribute('height', String(Math.max(0, r.h)));
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    if (handle) {
      el.dataset['handle'] = handle;
    }
    return el;
  }

  private cursor(at: { x: number; y: number }, color: string, name: string): SVGGElement {
    const g = this.doc.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${at.x} ${at.y})`);
    const arrow = this.doc.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 Z');
    arrow.setAttribute('fill', color);
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1');
    const label = this.doc.createElementNS(NS, 'text');
    label.setAttribute('x', '14');
    label.setAttribute('y', '28');
    label.setAttribute('font-size', '12');
    label.setAttribute('font-family', 'system-ui,sans-serif');
    label.setAttribute('fill', '#fff');
    label.setAttribute('stroke', color);
    label.setAttribute('stroke-width', '4');
    label.setAttribute('paint-order', 'stroke');
    label.textContent = name.slice(0, 40);
    g.append(arrow, label);
    g.dataset['peer'] = name;
    return g;
  }
}
