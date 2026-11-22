import { TEXT_TYPE, safeColor, displayColor } from '@apps/drawboard-engine';
import { BlockType } from '../renderer/block-registry';
import { renderSafeText } from '../util/safe-text';

/** A free text label without background. */
export const textBlock: BlockType = {
  type: TEXT_TYPE,
  label: 'Text',
  defaultSize: { w: 220, h: 48 },
  defaultProps: { color: '#0f172a', fontSize: 20 },
  textEditable: true,
  render(host, ctx) {
    const el = host.ownerDocument.createElement('div');
    el.className = 'be-text';
    el.style.cssText =
      'width:100%;height:100%;box-sizing:border-box;padding:4px 6px;overflow:hidden;white-space:pre-wrap;' +
      'overflow-wrap:anywhere;font-family:system-ui,sans-serif;line-height:1.3';
    host.appendChild(el);
    const apply = (props: Record<string, unknown>): void => {
      el.style.color = displayColor(safeColor(props['color'], '#0f172a'), ctx.theme());
      el.style.fontSize = `${typeof props['fontSize'] === 'number' ? props['fontSize'] : 20}px`;
      renderSafeText(el, ctx.text());
    };
    apply(ctx.block.props);
    return { update: (block) => apply(block.props), destroy: () => el.remove() };
  },
};
