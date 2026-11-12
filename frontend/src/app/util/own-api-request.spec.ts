import { isOwnApiRequest } from './own-api-request';

describe('isOwnApiRequest', () => {
  describe('matching', () => {
    it.each([
      ['/api', true],
      ['/api/boards', true],
      ['/api?x=1', true],
      ['/apiary', false],
      ['/config.json', false],
      ['https://evil.example/api/boards', false],
      ['//evil.example/api/boards', false],
      ['api/boards', false],
    ])('when the URL is %s then the result is %s', (url, expected) => {
      expect(isOwnApiRequest(url, '/api/'), `own API request: ${url}`).toBe(expected);
    });
  });
});
