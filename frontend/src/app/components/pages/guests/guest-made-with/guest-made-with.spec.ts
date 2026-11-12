import { TestBed } from '@angular/core/testing';

import { all, buttonByLabel, textOf } from '../../../../test/dom';
import { RuntimeConfig } from '../../../../services/runtime-config';
import { provideTestRuntimeConfig } from '../../../../test/runtime-config';
import { GuestMadeWith } from './guest-made-with';

describe('GuestMadeWith', () => {
  async function render(overrides: Partial<RuntimeConfig> = {}) {
    TestBed.configureTestingModule({ providers: [provideTestRuntimeConfig(overrides)] });
    const fixture = TestBed.createComponent(GuestMadeWith);
    await fixture.whenStable();
    return fixture;
  }

  describe('rendering', () => {
    it('when aboutUrl is set then the line links to it', async () => {
      const fixture = await render({ aboutUrl: 'https://draw.example.org' });
      const link = all<HTMLAnchorElement>(fixture, 'a')[0];

      expect(textOf(fixture), 'line').toMatch(/Made with Drawboard\s*·\s*Host your own/);
      expect(link.getAttribute('href'), 'link target').toBe('https://draw.example.org');
      expect(link.getAttribute('target'), 'target').toBe('_blank');
      expect(link.getAttribute('rel'), 'rel').toBe('noopener noreferrer');
    });

    it('when aboutUrl is empty then the host-your-own promotion is hidden', async () => {
      const fixture = await render({ aboutUrl: undefined });

      expect(textOf(fixture), 'line').not.toContain('Host your own');
      expect(all(fixture, 'a').length, 'links').toBe(0);
    });
  });

  describe('about dialog', () => {
    it('when Made with Drawboard is clicked then the About dialog with the source link opens', async () => {
      const fixture = await render({ aboutUrl: undefined, sourceUrl: 'https://git.example.org/x' });

      all(fixture, '[data-testid=made-with]')[0].click();
      await fixture.whenStable();

      expect(textOf(fixture), 'dialog').toContain('About Drawboard');
      expect(
        all<HTMLAnchorElement>(fixture, '[data-testid=about-source-link]')[0].getAttribute('href'),
        'source link',
      ).toBe('https://git.example.org/x');

      buttonByLabel(fixture, 'Close').click();
      await fixture.whenStable();

      expect(all(fixture, '[role=dialog]').length, 'dialog closed').toBe(0);
    });
  });
});
