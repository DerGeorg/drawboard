import { BlockData } from '../model/types';
import { BlockType } from './block-registry';
import { FULL_ZOOM, SIMPLE_NEUTRAL, SIMPLE_ZOOM, simpleAt, simpleFillOf } from './simple-view';

describe('simple view', () => {
  const block: BlockData = {
    id: 'b',
    type: 'x.y',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    rotation: 0,
    z: 1,
    parent: null,
    locked: false,
    props: {},
    hasText: false,
  };
  const type = (fill: (b: BlockData) => string, trusted = true): BlockType => ({
    type: 'x.y',
    label: 'X',
    defaultSize: { w: 1, h: 1 },
    defaultProps: {},
    simpleFill: fill,
    ...(trusted ? { trusted: true as const } : {}),
    render: () => ({ update: () => undefined, destroy: () => undefined }),
  });

  describe('simpleAt', () => {
    it('when the zoom crosses the thresholds then the mode switches with hysteresis', () => {
      expect(simpleAt(SIMPLE_ZOOM - 0.001, false), 'enter below').toBe(true);
      expect(simpleAt(SIMPLE_ZOOM, false), 'not at').toBe(false);
      expect(simpleAt(FULL_ZOOM - 0.001, true), 'stay below FULL_ZOOM').toBe(true);
      expect(simpleAt(FULL_ZOOM, true), 'leave at FULL_ZOOM').toBe(false);
    });
  });

  describe('simpleFillOf', () => {
    it('when a trusted type gives a hex colour or transparent then it is used', () => {
      expect(
        simpleFillOf(
          type(() => '#abcdef'),
          block,
        ),
        'hex',
      ).toBe('#abcdef');
      expect(
        simpleFillOf(
          type(() => 'transparent'),
          block,
        ),
        'transparent',
      ).toBe('transparent');
    });

    it('when the colour is not a plain hex colour then the box is neutral (S5.2)', () => {
      expect(
        simpleFillOf(
          type(() => 'url(https://evil.example/x)'),
          block,
        ),
        'url',
      ).toBe(SIMPLE_NEUTRAL);
    });

    it('when the type is untrusted, unknown, has no colour or throws then the box is neutral', () => {
      expect(
        simpleFillOf(
          type(() => '#abcdef', false),
          block,
        ),
        'plugin',
      ).toBe(SIMPLE_NEUTRAL);
      expect(simpleFillOf(undefined, block), 'unknown').toBe(SIMPLE_NEUTRAL);
      expect(
        simpleFillOf(
          type(() => {
            throw new Error('x');
          }),
          block,
        ),
        'throws',
      ).toBe(SIMPLE_NEUTRAL);
    });
  });
});
