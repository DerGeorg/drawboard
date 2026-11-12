import { blockedOrigin, cspViolationAttributes, reportCspViolations } from './csp-violation';

describe('csp violation reports (S3.12)', () => {
  describe('blocked origin', () => {
    it('when the blocked URI is a URL then only its origin is kept', () => {
      expect(blockedOrigin('https://cdn.example.com/a/b.js?token=secret#frag'), 'https').toBe(
        'https://cdn.example.com',
      );
      expect(blockedOrigin('http://localhost:4200/x'), 'with port').toBe('http://localhost:4200');
      expect(blockedOrigin('wss://draw.example.org/api/boards/1/collab?ticket=t'), 'wss').toBe(
        'wss://draw.example.org',
      );
      expect(blockedOrigin('blob:https://draw.example.org/1234-5678'), 'blob').toBe(
        'https://draw.example.org',
      );
    });

    it('when the blocked URI is a keyword or has no origin then no content leaks', () => {
      expect(blockedOrigin('inline'), 'keyword').toBe('inline');
      expect(blockedOrigin('trusted-types-sink'), 'trusted types').toBe('trusted-types-sink');
      expect(blockedOrigin(''), 'empty').toBe('none');
      expect(blockedOrigin('data:text/html;base64,PHNjcmlwdD4='), 'data URL').toBe('data:');
      expect(blockedOrigin('not a url, maybe a secret'), 'unparsable').toBe('unknown');
    });
  });

  describe('attributes', () => {
    it('when a violation is reported then it has the four fields and never the sample', () => {
      const event = {
        violatedDirective: "script-src-elem 'self'",
        effectiveDirective: 'script-src-elem',
        disposition: 'enforce',
        blockedURI: 'https://evil.example.com/x.js?a=b',
        sample: 'alert(document.cookie)',
        originalPolicy: "default-src 'self'",
      };

      const attributes = cspViolationAttributes(event);

      expect(attributes, 'exactly these').toEqual({
        violatedDirective: "script-src-elem 'self'",
        effectiveDirective: 'script-src-elem',
        disposition: 'enforce',
        blockedOrigin: 'https://evil.example.com',
      });
      expect(JSON.stringify(attributes), 'no sample, no query').not.toMatch(
        /alert|cookie|a=b|originalPolicy/,
      );
    });
  });

  describe('listener', () => {
    it('when the page reports a violation then it is sent as an event until stopped', () => {
      const sent: [string, unknown][] = [];
      const stop = reportCspViolations(document, (name, attributes) =>
        sent.push([name, attributes]),
      );
      const fire = (): void => {
        const event = new Event('securitypolicyviolation');
        Object.assign(event, {
          violatedDirective: 'require-trusted-types-for',
          effectiveDirective: 'require-trusted-types-for',
          disposition: 'report',
          blockedURI: 'trusted-types-sink',
          sample: 'secret',
        });
        document.dispatchEvent(event);
      };

      fire();
      stop();
      fire();

      expect(sent.length, 'one event, none after stop').toBe(1);
      expect(sent[0], 'the event').toEqual([
        'csp_violation',
        {
          violatedDirective: 'require-trusted-types-for',
          effectiveDirective: 'require-trusted-types-for',
          disposition: 'report',
          blockedOrigin: 'trusted-types-sink',
        },
      ]);
    });
  });
});
