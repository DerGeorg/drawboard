import { outputBinding } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { all, buttonByLabel, textOf } from '../../../test/dom';
import { RuntimeConfig } from '../../../services/runtime-config';
import { provideTestRuntimeConfig } from '../../../test/runtime-config';
import { AboutDialog } from './about-dialog';

describe('AboutDialog', () => {
  let closed: number;

  async function render(overrides: Partial<RuntimeConfig> = {}) {
    closed = 0;
    TestBed.configureTestingModule({
      providers: [provideTestRuntimeConfig({ version: '1.9.2', ...overrides })],
    });
    const fixture = TestBed.createComponent(AboutDialog, {
      bindings: [outputBinding('closed', () => closed++)],
    });
    await fixture.whenStable();
    return fixture;
  }

  describe('rendering', () => {
    it('when opened then name, version, description and licence sentence are shown', async () => {
      const fixture = await render();

      expect(textOf(fixture), 'dialog text').toContain('About Drawboard');
      expect(textOf(fixture), 'name and version').toContain('Drawboard 1.9.2');
      expect(textOf(fixture), 'description').toContain('A self-hosted collaborative whiteboard.');
      expect(textOf(fixture), 'licence').toContain(
        'Drawboard is free software under the GNU AGPL-3.0.',
      );
    });

    it('when opened then host your own and the source code go to the configured URLs', async () => {
      const fixture = await render({
        aboutUrl: 'https://draw.example.org',
        sourceUrl: 'https://git.example.org/fork',
      });
      const host = all<HTMLAnchorElement>(fixture, '[data-testid=about-host-link]')[0];
      const source = all<HTMLAnchorElement>(fixture, '[data-testid=about-source-link]')[0];

      expect(host.textContent?.trim(), 'primary link').toBe('Host your own Drawboard');
      expect(host.getAttribute('href'), 'primary link target').toBe('https://draw.example.org');
      expect(host.classList.contains('st-btn-primary-yellow'), 'primary style').toBe(true);
      expect(source.textContent?.trim(), 'source link').toBe('Source code (AGPL-3.0)');
      expect(source.getAttribute('href'), 'source link target').toBe(
        'https://git.example.org/fork',
      );
      for (const link of all<HTMLAnchorElement>(fixture, 'a')) {
        expect(link.getAttribute('target'), link.textContent ?? '').toBe('_blank');
        expect(link.getAttribute('rel'), link.textContent ?? '').toBe('noopener noreferrer');
      }
    });

    it('when aboutUrl is empty then host your own is hidden and the source stays', async () => {
      const fixture = await render({ aboutUrl: undefined });

      expect(textOf(fixture), 'dialog text').not.toContain('Host your own');
      expect(textOf(fixture), 'dialog text').toContain('Source code (AGPL-3.0)');
    });
  });

  describe('closing', () => {
    it('when Close is clicked then closed is emitted', async () => {
      const fixture = await render();

      buttonByLabel(fixture, 'Close').click();

      expect(closed, 'closed emissions').toBe(1);
    });
  });
});
