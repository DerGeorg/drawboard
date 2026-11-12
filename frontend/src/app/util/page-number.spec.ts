import { pageIndexFromQuery } from './page-number';

describe('pageIndexFromQuery', () => {
  describe('conversion', () => {
    it.each([
      [undefined, 0],
      ['1', 0],
      ['3', 2],
      [3, 2],
      ['0', 0],
      ['-2', 0],
      ['abc', 0],
      ['1.5', 0],
    ])('when the query value is %s then the page index is %s', (value, expected) => {
      expect(pageIndexFromQuery(value), `page index for ${String(value)}`).toBe(expected);
    });
  });
});
