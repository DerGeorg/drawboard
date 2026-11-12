import { safeColor } from '../presence';
import { BlockData } from '../model/types';
import { BlockType } from '../renderer/block-registry';
import { renderSafeText } from '../util/safe-text';

export const SHAPE_TYPE = 'core.shape';
export type ShapeKind = 'rect' | 'ellipse' | 'diamond';

const NS = 'http://www.w3.org/2000/svg';

/** The outline of a shape inside a w x h box, inset by half the stroke so it is not clipped. */
export function shapeGeometry(
  kind: ShapeKind,
  w: number,
  h: number,
  inset: number,
): { tag: 'rect' | 'ellipse' | 'polygon'; attrs: Record<string, string> } {
  const iw = Math.max(0, w - inset * 2);
  const ih = Math.max(0, h - inset * 2);
  if (kind === 'ellipse') {
    return {
      tag: 'ellipse',
      attrs: { cx: String(w / 2), cy: String(h / 2), rx: String(iw / 2), ry: String(ih / 2) },
    };
  }
  if (kind === 'diamond') {
    const pts = [
      `${w / 2},${inset}`,
      `${w - inset},${h / 2}`,
      `${w / 2},${h - inset}`,
      `${inset},${h / 2}`,
    ];
    return { tag: 'polygon', attrs: { points: pts.join(' ') } };
  }
  return {
    tag: 'rect',
    attrs: { x: String(inset), y: String(inset), width: String(iw), height: String(ih), rx: '6' },
  };
}

function kindOf(block: BlockData): ShapeKind {
  const k = block.props['kind'];
  return k === 'ellipse' || k === 'diamond' ? k : 'rect';
}

/** Rectangle, ellipse or diamond with optional centered text. */
export const shapeBlock: BlockType = {
  type: SHAPE_TYPE,
  label: 'Shape',
  defaultSize: { w: 180, h: 110 },
  defaultProps: { kind: 'rect', fill: '#ffffff', stroke: '#334155', strokeWidth: 2 },
  textEditable: true,
  // far out a shape is its fill, or its outline colour when it has no fill
  simpleFill: (block) =>
    block.props['fill'] === 'transparent'
      ? safeColor(block.props['stroke'], '#334155')
      : safeColor(block.props['fill'], '#ffffff'),
  render(host, ctx) {
    const doc = host.ownerDocument;
    const svg = doc.createElementNS(NS, 'svg');
    svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible';
    const label = doc.createElement('div');
    label.className = 'be-text';
    label.style.cssText =
      'position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;padding:10px;display:flex;' +
      'align-items:center;justify-content:center;text-align:center;overflow:hidden;white-space:pre-wrap;' +
      'overflow-wrap:anywhere;font:16px/1.3 system-ui,sans-serif;color:#1f2937';
    host.append(svg, label);

    let shape: SVGElement | undefined;
    let shapeTag = '';
    const apply = (block: BlockData): void => {
      const strokeWidth =
        typeof block.props['strokeWidth'] === 'number' ? block.props['strokeWidth'] : 2;
      const g = shapeGeometry(kindOf(block), block.w, block.h, strokeWidth / 2);
      if (!shape || shapeTag !== g.tag) {
        shape?.remove();
        shape = doc.createElementNS(NS, g.tag);
        shapeTag = g.tag;
        svg.appendChild(shape);
      }
      svg.setAttribute('viewBox', `0 0 ${block.w} ${block.h}`);
      for (const [k, v] of Object.entries(g.attrs)) {
        shape.setAttribute(k, v);
      }
      const fill = block.props['fill'];
      const stroke = block.props['stroke'];
      // props come from any editor: only plain hex colours reach the SVG (finding 6 of the M1 review)
      shape.setAttribute('fill', fill === 'none' ? 'none' : safeColor(fill, 'none'));
      shape.setAttribute('stroke', safeColor(stroke, '#334155'));
      shape.setAttribute('stroke-width', String(strokeWidth));
      shape.setAttribute('stroke-linejoin', 'round');
      renderSafeText(label, ctx.text());
    };
    apply(ctx.block);
    return {
      update: apply,
      destroy: () => {
        svg.remove();
        label.remove();
      },
    };
  },
};
