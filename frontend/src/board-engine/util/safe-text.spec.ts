import { renderSafeText, safeUrl } from './safe-text';

function render(text: string): HTMLElement {
  const el = document.createElement('div');
  renderSafeText(el, text);
  return el;
}

describe('safe-text', () => {
  describe('safeUrl', () => {
    it.each(['https://example.com/a?b=1', 'http://example.com', 'mailto:a@example.com'])(
      'when %s is checked then it is allowed',
      (url) => expect(safeUrl(url), 'url').toBeDefined(),
    );

    it.each([
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'not a url',
      'vbscript:x',
    ])('when %s is checked then it is rejected', (url) =>
      expect(safeUrl(url), 'url').toBeUndefined(),
    );
  });

  describe('renderSafeText', () => {
    it('when the text has markup then it stays text and creates no elements', () => {
      const el = render('<img src=x onerror=alert(1)><b>x</b>');

      expect(el.querySelector('img, b'), 'elements').toBeNull();
      expect(el.textContent, 'text').toBe('<img src=x onerror=alert(1)><b>x</b>');
    });

    it('when the text has a link then it is an anchor with the hardened attributes', () => {
      const el = render('see https://example.com/x, then go');
      const a = el.querySelector('a');

      expect(a?.getAttribute('href'), 'href').toBe('https://example.com/x');
      expect(a?.target, 'target').toBe('_blank');
      expect(a?.rel, 'rel').toBe('noopener noreferrer nofollow');
      expect(a?.referrerPolicy, 'referrer policy').toBe('no-referrer');
      expect(a?.title, 'host on hover').toBe('example.com');
      expect(el.textContent, 'the comma stays outside the link').toBe(
        'see https://example.com/x, then go',
      );
      expect(a?.textContent, 'link text').toBe('https://example.com/x');
    });

    it('when the text has a mailto link then it is linked with the address as hover text', () => {
      const a = render('mail mailto:a@example.com now').querySelector('a');

      expect(a?.getAttribute('href'), 'href').toBe('mailto:a@example.com');
    });

    it('when the text is longer than the limit then it is cut', () => {
      expect(render('a'.repeat(100_005)).textContent?.length, 'length').toBe(100_000);
    });

    it('when rendered twice then the old content is replaced', () => {
      const el = render('one');
      renderSafeText(el, 'two');

      expect(el.textContent, 'text').toBe('two');
    });
  });
});
