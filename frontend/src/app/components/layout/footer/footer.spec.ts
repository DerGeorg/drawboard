import { TestBed } from '@angular/core/testing';

import { all, textOf } from '../../../test/dom';
import { provideTestRuntimeConfig } from '../../../test/runtime-config';
import { RuntimeConfig } from '../../../services/runtime-config';
import { Footer } from './footer';

describe('Footer', () => {
  async function render(overrides: Partial<RuntimeConfig> = {}) {
    TestBed.configureTestingModule({ providers: [provideTestRuntimeConfig(overrides)] });
    const fixture = TestBed.createComponent(Footer);
    await fixture.whenStable();
    return fixture;
  }

  describe('rendering', () => {
    it('when rendered then version and environment of the runtime config are shown', async () => {
      const fixture = await render({ version: '1.4.0', environment: 'prod' });

      expect(textOf(fixture), 'footer text').toContain('Version 1.4.0 · prod');
    });
  });

  describe('links', () => {
    it('when rendered then licence, source code and host your own point to the configured URLs', async () => {
      const fixture = await render({
        sourceUrl: 'https://git.example.org/fork',
        aboutUrl: 'https://draw.example.org',
      });

      const links = all<HTMLAnchorElement>(fixture, 'a');

      expect(
        links.map((a) => [a.textContent?.trim(), a.getAttribute('href')]),
        'links',
      ).toEqual([
        ['AGPL-3.0', 'https://www.gnu.org/licenses/agpl-3.0.html'],
        ['Source code', 'https://git.example.org/fork'],
        ['Host your own', 'https://draw.example.org'],
      ]);
      expect(textOf(fixture), 'footer text').toMatch(
        /AGPL-3\.0\s*·\s*Source code\s*·\s*Host your own/,
      );
    });

    it('when rendered then every link opens in a new tab without opener and referrer', async () => {
      const fixture = await render();

      for (const link of all<HTMLAnchorElement>(fixture, 'a')) {
        expect(link.getAttribute('target'), link.textContent ?? '').toBe('_blank');
        expect(link.getAttribute('rel'), link.textContent ?? '').toBe('noopener noreferrer');
      }
    });

    it('when aboutUrl is empty then only host your own is hidden', async () => {
      const fixture = await render({ aboutUrl: undefined });

      expect(textOf(fixture), 'footer text').not.toContain('Host your own');
      expect(textOf(fixture), 'footer text').toContain('Source code');
      expect(textOf(fixture), 'footer text').toContain('AGPL-3.0');
    });
  });
});
