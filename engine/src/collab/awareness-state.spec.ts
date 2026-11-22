import {
  MAX_COORD,
  MAX_SUMMON_TARGETS,
  encodeViewport,
  newSummonId,
  parsePeerState,
  parseSummon,
  parseViewport,
  sameViewport,
  summons,
} from './awareness-state.js';

describe('awareness state', () => {
  describe('encodeViewport', () => {
    it('when a viewport is published then the centre is rounded to world units and the zoom to 4 decimals', () => {
      expect(encodeViewport({ x: 10.4, y: -3.6 }, 0.123456), 'rounded').toEqual({
        x: 10,
        y: -4,
        zoom: 0.1235,
      });
    });

    it('when values are out of range then they are clamped to what receivers accept', () => {
      const v = encodeViewport({ x: 1e12, y: -1e12 }, 100);

      expect(v, 'clamped').toEqual({ x: MAX_COORD, y: -MAX_COORD, zoom: 8 });
      expect(parseViewport(v), 'accepted').toEqual(v);
    });

    it('when two viewports are compared then equal values are the same', () => {
      expect(sameViewport({ x: 1, y: 2, zoom: 1 }, { x: 1, y: 2, zoom: 1 }), 'same').toBe(true);
      expect(sameViewport({ x: 1, y: 2, zoom: 1 }, null), 'null').toBe(false);
      expect(sameViewport(null, null), 'both null').toBe(true);
    });
  });

  describe('parsePeerState', () => {
    it('when every field is valid then it is read, and unknown fields are ignored', () => {
      const s = parsePeerState({
        cursor: { x: 1, y: 2 },
        selection: ['a'],
        viewport: { x: 5, y: 6, zoom: 0.5 },
        following: 42,
        summon: { id: 9, targets: 'all' },
        name: 'Mallory',
        html: '<b>x</b>',
      });

      expect(s, 'state').toEqual({
        cursor: { x: 1, y: 2 },
        selection: ['a'],
        viewport: { x: 5, y: 6, zoom: 0.5 },
        following: 42,
        summon: { id: 9, targets: 'all' },
      });
    });

    it('when the state is not an object then every field is empty', () => {
      for (const bad of [null, 'x', 7, [1, 2], undefined]) {
        expect(parsePeerState(bad), String(bad)).toEqual({
          cursor: null,
          selection: [],
          viewport: null,
          following: null,
          summon: null,
        });
      }
    });

    it('when numbers are not finite or out of bounds then the field is dropped', () => {
      const s = parsePeerState({
        cursor: { x: Infinity, y: 0 },
        viewport: { x: 0, y: MAX_COORD + 1, zoom: 1 },
        following: -1,
      });

      expect(s.cursor, 'cursor').toBeNull();
      expect(s.viewport, 'viewport').toBeNull();
      expect(s.following, 'following').toBeNull();
      expect(parsePeerState({ following: 2 ** 32 }).following, 'beyond uint32').toBeNull();
      expect(parsePeerState({ following: 1.5 }).following, 'fraction').toBeNull();
    });

    it('when the zoom of a viewport is outside 2 % - 800 % then the viewport is dropped', () => {
      expect(parseViewport({ x: 0, y: 0, zoom: 0.001 }), 'too far out').toBeNull();
      expect(parseViewport({ x: 0, y: 0, zoom: 9 }), 'too close').toBeNull();
      expect(parseViewport({ x: 0, y: 0, zoom: '1' }), 'string').toBeNull();
      expect(parseViewport({ x: 0, y: 0, zoom: NaN }), 'NaN').toBeNull();
    });

    it('when fields come only from the prototype then they are not read', () => {
      const proto = { viewport: { x: 1, y: 1, zoom: 1 } };
      const state = Object.create(proto) as object;

      expect(parsePeerState(state).viewport, 'inherited').toBeNull();
      expect(
        parsePeerState(JSON.parse('{"__proto__": {"following": 3}}')).following,
        '__proto__ key',
      ).toBeNull();
    });

    it('when the selection holds non-strings, long ids or too many ids then it is cut', () => {
      const s = parsePeerState({ selection: ['a', 5, 'x'.repeat(65), ...Array(200).fill('b')] });

      expect(s.selection[0], 'first').toBe('a');
      expect(s.selection.length, 'at most 100 looked at').toBeLessThanOrEqual(100);
      expect(s.selection.includes('x'.repeat(65)), 'long id').toBe(false);
    });
  });

  describe('parseSummon', () => {
    it('when a summon names everyone or a few client ids then it is read', () => {
      expect(parseSummon({ id: 1, targets: 'all' }), 'all').toEqual({ id: 1, targets: 'all' });
      expect(parseSummon({ id: 2, targets: [3, 4] }), 'list').toEqual({ id: 2, targets: [3, 4] });
    });

    it('when the target list is too long, empty or holds a bad id then there is no summon', () => {
      const many = Array.from({ length: MAX_SUMMON_TARGETS + 1 }, (_, i) => i);

      expect(parseSummon({ id: 1, targets: many }), 'too many').toBeNull();
      expect(parseSummon({ id: 1, targets: [] }), 'empty').toBeNull();
      expect(parseSummon({ id: 1, targets: [1, 'x'] }), 'bad id').toBeNull();
      expect(parseSummon({ id: 1, targets: 'some' }), 'unknown word').toBeNull();
    });

    it('when the id is missing, not an integer or out of range then there is no summon', () => {
      expect(parseSummon({ targets: 'all' }), 'missing').toBeNull();
      expect(parseSummon({ id: 0, targets: 'all' }), 'zero').toBeNull();
      expect(parseSummon({ id: 1.5, targets: 'all' }), 'fraction').toBeNull();
      expect(parseSummon({ id: 2 ** 31, targets: 'all' }), 'too big').toBeNull();
    });

    it('when a summon carries text then the text is not part of it', () => {
      expect(parseSummon({ id: 1, targets: 'all', message: 'click here' }), 'no text').toEqual({
        id: 1,
        targets: 'all',
      });
    });

    it('when asked whether a summon names a client then everyone and listed ids count', () => {
      expect(summons({ id: 1, targets: 'all' }, 5), 'all').toBe(true);
      expect(summons({ id: 1, targets: [5] }, 5), 'listed').toBe(true);
      expect(summons({ id: 1, targets: [6] }, 5), 'not listed').toBe(false);
      expect(summons(null, 5), 'none').toBe(false);
    });

    it('when a new summon id is made then it is a valid id', () => {
      expect(parseSummon({ id: newSummonId(() => 0), targets: 'all' }), 'low').not.toBeNull();
      expect(
        parseSummon({ id: newSummonId(() => 0.999999), targets: 'all' }),
        'high',
      ).not.toBeNull();
    });
  });
});
