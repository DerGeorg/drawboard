import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  describe('units', () => {
    it.each([
      [0, '0 B'],
      [512, '512 B'],
      [3400, '3.4 kB'],
      [12_000, '12 kB'],
      [5_200_000, '5.2 MB'],
      [2_000_000_000, '2.0 GB'],
    ])('when %i bytes are formatted then the text is %s', (bytes, text) => {
      expect(formatBytes(bytes), 'text').toBe(text);
    });

    it('when the value is not a size then nothing is returned', () => {
      expect(formatBytes(-1), 'negative').toBe('');
      expect(formatBytes(Number.NaN), 'NaN').toBe('');
    });
  });
});
