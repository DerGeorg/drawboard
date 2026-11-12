import { initials } from './initials';

describe('initials', () => {
  describe('name', () => {
    it.each([
      ['Alice Admin', 'AA'],
      ['alice', 'A'],
      ['  bob   the  builder ', 'BB'],
      ['Élodie Durand', 'ÉD'],
      ['Alice Admin (you)', 'AA'],
      ['', '?'],
      ['   ', '?'],
    ])('when the name is "%s" then the initials are %s', (name, expected) => {
      expect(initials(name), `initials of "${name}"`).toBe(expected);
    });

    it('when the name starts with an emoji then the whole character is kept', () => {
      expect(initials('😀 Smile'), 'initials').toBe('😀S');
    });
  });
});
