import { BlockData, Props } from '../model/types';
import { shapeBlock } from './shape';

describe('shapeBlock', () => {
  const aShape = (props: Props): BlockData => ({
    id: 's1',
    type: 'core.shape',
    x: 0,
    y: 0,
    w: 120,
    h: 80,
    rotation: 0,
    z: 1,
    parent: null,
    locked: false,
    props: { kind: 'rect', ...props },
    hasText: true,
  });

  function outline(props: Props): SVGElement {
    const host = document.createElement('div');
    shapeBlock.render(host, { block: aShape(props), text: () => '', readOnly: false });
    return host.querySelector('svg [fill]') as SVGElement;
  }

  describe('colors', () => {
    it('when fill and stroke are hex colors then they are used', () => {
      const shape = outline({ fill: '#bbf7d0', stroke: '#1d4ed8' });

      expect(shape.getAttribute('fill'), 'fill').toBe('#bbf7d0');
      expect(shape.getAttribute('stroke'), 'stroke').toBe('#1d4ed8');
    });

    it('when a remote editor sets url() references then they never reach the SVG', () => {
      const shape = outline({
        fill: 'url(https://attacker.example/x.svg#p)',
        stroke: 'url(https://attacker.example/x.svg#q)',
      });

      expect(shape.getAttribute('fill'), 'fill').toBe('none');
      expect(shape.getAttribute('stroke'), 'stroke').toBe('#334155');
    });
  });
});
