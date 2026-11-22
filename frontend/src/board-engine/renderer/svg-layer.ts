import {
  BoardDoc,
  safeColor,
  BoardTheme,
  displayColor,
  ConnectorData,
  Point,
} from '@apps/drawboard-engine';
import { connectorEndpoints } from '../scene';
import { strokePath } from './stroke-path';

const NS = 'http://www.w3.org/2000/svg';

/** One SVG in world coordinates for connectors and freehand strokes (above the blocks). */
export class SvgLayer {
  readonly svg: SVGSVGElement;
  private readonly connectorGroup: SVGGElement;
  private readonly strokeGroup: SVGGElement;
  private readonly connectorEls = new Map<string, SVGGElement>();
  private readonly strokeEls = new Map<string, SVGPathElement>();
  private theme: BoardTheme = 'light';

  constructor(
    doc: Document,
    private readonly board: BoardDoc,
  ) {
    this.svg = doc.createElementNS(NS, 'svg');
    this.svg.setAttribute('width', '1');
    this.svg.setAttribute('height', '1');
    this.svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none';
    this.connectorGroup = doc.createElementNS(NS, 'g');
    this.strokeGroup = doc.createElementNS(NS, 'g');
    this.svg.append(this.connectorGroup, this.strokeGroup);
  }

  /** Redraws every connector and stroke in the colours of `theme` (the document is untouched). */
  setTheme(theme: BoardTheme): void {
    if (theme !== this.theme) {
      this.theme = theme;
      this.renderAll();
    }
  }

  renderAll(): void {
    this.syncConnectors(this.board.connectorIds());
    this.syncStrokes(this.board.strokeIds());
  }

  syncConnectors(ids: Iterable<string>): void {
    for (const id of ids) {
      this.connectorEls.get(id)?.remove();
      this.connectorEls.delete(id);
      const c = this.board.getConnector(id);
      const el = c && this.buildConnector(c);
      if (el) {
        this.connectorGroup.appendChild(el);
        this.connectorEls.set(id, el);
      }
    }
  }

  syncStrokes(ids: Iterable<string>): void {
    for (const id of ids) {
      this.strokeEls.get(id)?.remove();
      this.strokeEls.delete(id);
      const s = this.board.getStroke(id);
      if (s) {
        const path = this.svg.ownerDocument.createElementNS(NS, 'path');
        path.setAttribute('d', strokePath(s));
        path.setAttribute('fill', displayColor(safeColor(s.style.color, '#0f172a'), this.theme));
        path.dataset['strokeId'] = id;
        this.strokeGroup.appendChild(path);
        this.strokeEls.set(id, path);
      }
    }
  }

  /** Connectors attached to any of these blocks (they follow moved or resized blocks). */
  connectorsAttachedTo(blockIds: ReadonlySet<string>): string[] {
    return this.board
      .connectors()
      .filter((c) => [c.from, c.to].some((e) => 'block' in e && blockIds.has(e.block)))
      .map((c) => c.id);
  }

  destroy(): void {
    this.svg.remove();
  }

  private buildConnector(c: ConnectorData): SVGGElement | undefined {
    const ends = connectorEndpoints(this.board, c);
    if (!ends) {
      return undefined;
    }
    const doc = this.svg.ownerDocument;
    const [a, b] = ends;
    const g = doc.createElementNS(NS, 'g');
    g.dataset['connectorId'] = c.id;
    const line = doc.createElementNS(NS, 'path');
    let d = `M${a.x} ${a.y} L${b.x} ${b.y}`;
    if (c.style.arrow) {
      d += ' ' + arrowHead(a, b, 8 + c.style.width * 2);
    }
    line.setAttribute('d', d);
    line.setAttribute('fill', 'none');
    const color = displayColor(safeColor(c.style.color, '#334155'), this.theme);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(c.style.width));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    if (c.style.dashed) {
      line.setAttribute('stroke-dasharray', `${c.style.width * 3} ${c.style.width * 2}`);
    }
    g.appendChild(line);
    if (c.label) {
      const text = doc.createElementNS(NS, 'text');
      text.setAttribute('x', String((a.x + b.x) / 2));
      text.setAttribute('y', String((a.y + b.y) / 2 - 6));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '14');
      text.setAttribute('fill', color);
      text.textContent = c.label;
      g.appendChild(text);
    }
    return g;
  }
}

/** Two short lines forming an arrow head at `to`. */
export function arrowHead(from: Point, to: Point, size: number): string {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  const p1 = {
    x: to.x - size * Math.cos(angle - spread),
    y: to.y - size * Math.sin(angle - spread),
  };
  const p2 = {
    x: to.x - size * Math.cos(angle + spread),
    y: to.y - size * Math.sin(angle + spread),
  };
  return `M${p1.x} ${p1.y} L${to.x} ${to.y} L${p2.x} ${p2.y}`;
}
