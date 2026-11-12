import { HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { all, buttonByText, textOf } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { Toasts } from '../../../../services/toasts';
import { aPlugin } from '../testing/plugins';
import { MAX_PLUGIN_ZIP_BYTES, PluginAdmin } from './plugin-admin';

describe('PluginAdmin', () => {
  let fixture: ComponentFixture<PluginAdmin>;

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    fixture = TestBed.createComponent(PluginAdmin);
    await settle();
  }

  async function loaded(items = [aPlugin()]): Promise<void> {
    await render();
    expectRequest('GET', '/api/admin/plugins', 'list').flush({ items });
    await settle();
    await fixture.whenStable();
  }

  function pick(file: File): void {
    const picker = all<HTMLInputElement>(fixture, 'input[type=file]')[0] as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    picker.dispatchEvent(new Event('change'));
  }

  const zip = (size = 10, name = 'counter.zip'): File => {
    const f = new File(['PK'], name, { type: 'application/zip' });
    Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('list', () => {
    it('when plugins are installed then each one is shown', async () => {
      await loaded([aPlugin(), aPlugin({ id: 'org.example.poll', name: 'Poll' })]);

      expect(all(fixture, 'drawboard-plugin-card').length, 'cards').toBe(2);
    });

    it('when none is installed then the page says so', async () => {
      await loaded([]);

      expect(textOf(fixture), 'empty').toContain('No plugins are installed.');
    });

    it('when a card was saved then it shows the new state', async () => {
      await loaded();
      const card = all(fixture, 'drawboard-plugin-card')[0] as HTMLElement;
      const toggle = card.querySelector<HTMLInputElement>('input.toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      toggle.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();

      expectRequest('PUT', '/api/admin/plugins/org.example.counter', 'save').flush(
        aPlugin({ enabled: true, revision: 4 }),
      );
      await settle();
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=state]')[0]?.textContent?.trim(), 'enabled').toBe(
        'Enabled',
      );
    });
  });

  describe('conflict', () => {
    it('when a card reports a change elsewhere then the list is read again', async () => {
      await loaded();
      const card = all(fixture, 'drawboard-plugin-card')[0] as HTMLElement;
      const toggle = card.querySelector<HTMLInputElement>('input.toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      toggle.dispatchEvent(new Event('input'));
      await fixture.whenStable();
      buttonByText(fixture, 'Save').click();
      await settle();

      expectRequest('PUT', '/api/admin/plugins/org.example.counter', 'save').flush(
        aProblem({ code: 'CONFLICT', status: 409 }),
        problemResponse(409, 'Conflict'),
      );
      await settle();

      expectRequest('GET', '/api/admin/plugins', 'read again').flush({ items: [aPlugin()] });
      expect(
        TestBed.inject(Toasts)
          .toasts()
          .some((t) => t.message.includes('read again')),
        'told',
      ).toBe(true);
    });
  });

  describe('install', () => {
    it('when a ZIP is uploaded then it is installed and the list is read again', async () => {
      await loaded([]);

      pick(zip());
      await settle();
      const req = expectRequest('POST', '/api/admin/plugins', 'install');
      expect((req.request.body as FormData).get('file'), 'file part').toBeInstanceOf(File);
      req.flush(aPlugin(), { status: 201, statusText: 'Created' });
      await settle();

      expect(TestBed.inject(Toasts).toasts()[0]?.message, 'told').toContain(
        'Review its capabilities',
      );
      expectRequest('GET', '/api/admin/plugins', 'list again').flush({ items: [aPlugin()] });
    });

    it('when the manifest is invalid then every violation is listed with the request id', async () => {
      await loaded([]);

      pick(zip());
      await settle();
      expectRequest('POST', '/api/admin/plugins', 'install').flush(
        aProblem({
          code: 'PLUGINS_MANIFEST_INVALID',
          status: 400,
          requestId: 'req-7',
          violations: [
            { field: 'blockTypes[0].type', code: 'Pattern', message: 'must start with the id' },
          ],
        }),
        problemResponse(400, 'Bad Request', 'req-7'),
      );
      await settle();
      await fixture.whenStable();

      const error = all(fixture, '[data-testid=install-error]')[0];
      expect(error?.textContent, 'message').toContain('The plugin manifest is not valid.');
      expect(error?.textContent, 'violation').toContain(
        'blockTypes[0].type: must start with the id',
      );
      expect(error?.textContent, 'request id').toContain('req-7');
    });

    it.each([
      ['not a ZIP', zip(10, 'plugin.tar'), 'uploaded as a .zip file'],
      ['larger than 20 MB', zip(MAX_PLUGIN_ZIP_BYTES + 1), 'larger than 20 MB'],
    ])('when the file is %s then it is not sent', async (_name, file, text) => {
      await loaded([]);

      pick(file);
      await settle();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=install-error]')[0]?.textContent, 'reason').toContain(text);
    });
  });
});
