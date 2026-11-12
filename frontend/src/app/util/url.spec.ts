import { stripQuery } from './url';

describe('stripQuery', () => {
  describe('stripping', () => {
    it.each([
      ['https://app.example/boards?page=2', 'https://app.example/boards'],
      ['/boards#top', '/boards'],
      ['/boards?a=1#b', '/boards'],
      ['/boards', '/boards'],
    ])('when the URL is %s then %s remains', (url, expected) => {
      expect(stripQuery(url), `stripped ${url}`).toBe(expected);
    });
  });
});
