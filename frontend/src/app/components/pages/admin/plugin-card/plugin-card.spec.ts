import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Plugin } from '@apps/drawboard-api';

import { all, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { aPlugin } from '../testing/plugins';
import { PluginCard } from './plugin-card';

describe('PluginCard', () => {
  let fixture: ComponentFixture<PluginCard>;
  const plugin = signal<Plugin>(aPlugin());
  let changes: (Plugin | undefined)[];
  let removals: string[];

  async function render(p = aPlugin()): Promise<void> {
    plugin.set(p);
    changes = [];
    removals = [];
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(PluginCard, {
      bindings: [
        inputBinding('plugin', plugin),
        outputBinding<Plugin | undefined>('changed', (c) => changes.push(c)),
        outputBinding<string>('removed', (id) => removals.push(id)),
      ],
    });
    await fixture.whenStable();
  }

  const box = (name: string): HTMLInputElement =>
    all<HTMLInputElement>(fixture, `input[data-capability="${name}"]`)[0] as HTMLInputElement;
  const toggle = (): HTMLInputElement =>
    all<HTMLInputElement>(fixture, 'input.toggle')[0] as HTMLInputElement;

  function click(input: HTMLInputElement): void {
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
    input.dispatchEvent(new Event('input'));
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('review', () => {
    it('when shown then hash, state, granted capabilities and every network host are visible', async () => {
      await render();

      expect(all(fixture, '[data-testid=sha384]')[0]?.textContent, 'hash').toBe('f'.repeat(96));
      expect(all(fixture, '[data-testid=state]')[0]?.textContent?.trim(), 'state').toBe('Disabled');
      expect(box('block.props').checked, 'granted').toBe(true);
      expect(box('storage').checked, 'not granted').toBe(false);
      expect(
        all(fixture, '[data-testid=network-hosts] li').map((li) => li.textContent),
        'hosts one by one',
      ).toEqual(['https://api.example.org', 'https://tiles.example.org:8443']);
      expect(textOf(fixture), 'what network means').toContain('without the user’s credentials');
    });

    it('when a capability exposes board data then the text says the plugin can send it anywhere', async () => {
      await render(
        aPlugin({ requestedCapabilities: [{ name: 'block.props' }, { name: 'board.read' }] }),
      );

      const text = (name: string): string => box(name).closest('label')?.textContent ?? '';
      expect(text('block.props'), 'block.props').toContain('send this data anywhere');
      expect(text('board.read'), 'board.read').toContain('send this data anywhere');
    });

    it('when a description holds markup then it is shown as text', async () => {
      await render(aPlugin({ description: '<img src=x onerror=alert(1)>' }));

      expect(all(fixture, 'img').length, 'no element from it').toBe(0);
      expect(textOf(fixture), 'text').toContain('<img src=x onerror=alert(1)>');
    });
  });

  describe('saving', () => {
    it('when capabilities are granted and the plugin enabled then the whole state goes out with the revision', async () => {
      await render();
      expect(buttonByText(fixture, 'Save').disabled, 'nothing changed yet').toBe(true);

      click(box('network'));
      click(toggle());
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();

      const req = expectRequest('PUT', '/api/admin/plugins/org.example.counter', 'update');
      expect(req.request.body, 'complete state').toEqual({
        enabled: true,
        grantedCapabilities: [
          { name: 'block.props' },
          { name: 'network', value: 'api.example.org tiles.example.org:8443' },
        ],
        revision: 3,
      });
      req.flush(aPlugin({ enabled: true, revision: 4 }));
      await settle();
      expect(changes[0]?.revision, 'saved').toBe(4);
    });

    it('when another admin changed it meanwhile then the page is asked to read it again', async () => {
      await render();
      click(toggle());
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();

      expectRequest('PUT', '/api/admin/plugins/org.example.counter', 'update').flush(
        aProblem({ code: 'CONFLICT', status: 409 }),
        problemResponse(409, 'Conflict'),
      );
      await settle();

      expect(changes, 'read again').toEqual([undefined]);
    });
  });

  describe('removing', () => {
    it('when Remove is confirmed then the plugin is removed', async () => {
      await render();

      buttonByText(fixture, 'Remove').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'what happens').toContain('stay on the boards as placeholders');
      buttonByText(fixture, 'Remove plugin').click();
      await settle();
      expectRequest('DELETE', '/api/admin/plugins/org.example.counter', 'remove').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();

      expect(removals, 'removed').toEqual(['org.example.counter']);
    });

    it('when Remove is cancelled then nothing is sent', async () => {
      await render();

      buttonByText(fixture, 'Remove').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'dialog closed').not.toContain('Remove plugin');
    });

    it('when removing fails then the dialog stays', async () => {
      await render();
      buttonByText(fixture, 'Remove').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Remove plugin').click();
      await settle();

      expectRequest('DELETE', '/api/admin/plugins/org.example.counter', 'remove').flush(
        aProblem({ status: 500 }),
        problemResponse(500, 'Error'),
      );
      await settle();
      await fixture.whenStable();

      expect(removals, 'not removed').toEqual([]);
      expect(textOf(fixture), 'still asking').toContain('Remove plugin');
    });
  });
});
