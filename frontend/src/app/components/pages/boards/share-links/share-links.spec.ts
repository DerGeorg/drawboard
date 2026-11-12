import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ShareLink } from '@apps/drawboard-api';

import { all, buttonByText, textOf, typeInto } from '../../../../test/dom';
import { provideFakeAuth } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { aShareLink } from '../testing/share';
import { ShareLinks } from './share-links';

const URL = 'https://drawboard.test/s#TOKEN-SHOWN-ONCE';

describe('ShareLinks', () => {
  let fixture: ComponentFixture<ShareLinks>;
  const base = `/api/boards/${SPRINT_BOARD_ID}/links`;

  async function render(links: ShareLink[] = [], guestLinksEnabled = false): Promise<void> {
    const fake = provideFakeAuth();
    fake.auth.signIn('alice', 'Alice Admin', false, guestLinksEnabled);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), fake.providers],
    });
    fixture = TestBed.createComponent(ShareLinks, {
      bindings: [
        inputBinding('kind', () => 'board'),
        inputBinding('resourceId', () => SPRINT_BOARD_ID),
      ],
    });
    await settle();
    expectRequest('GET', base, 'list links').flush({ items: links });
    await settle();
    await fixture.whenStable();
  }

  /** Submits the form and answers the POST with a created link. */
  async function create(link = aShareLink()): Promise<ReturnType<typeof expectRequest>> {
    buttonByText(fixture, 'Create link').click();
    await settle();
    const post = expectRequest('POST', base, 'create link');
    post.flush({ link, url: URL }, { status: 201, statusText: 'Created' });
    await settle();
    expectRequest('GET', base, 'reload links').flush({ items: [link] });
    await settle();
    await fixture.whenStable();
    return post;
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('creating a link', () => {
    it('when guests are not enabled then only "Anyone signed in" is offered', async () => {
      await render();

      expect(all(fixture, 'input[type=radio]').length, 'audiences').toBe(1);
      expect(textOf(fixture), 'text').not.toContain('Guests without account');
    });

    it('when guests are enabled then "Guests without account" is offered as well, not preselected', async () => {
      await render([], true);

      const radios = all<HTMLInputElement>(fixture, 'input[type=radio]');
      expect(
        radios.map((r) => r.value),
        'audiences',
      ).toEqual(['SIGNED_IN', 'GUESTS']);
      expect(radios[0].checked, 'default').toBe(true);
    });

    it('when created with the defaults then a viewer link for signed-in users is requested', async () => {
      await render();

      const post = await create();

      expect(post.request.body, 'body').toEqual({ audience: 'SIGNED_IN', role: 'VIEWER' });
    });

    it('when role, guests, expiry and password are set then all of them are sent', async () => {
      await render([], true);
      const guests = all<HTMLInputElement>(fixture, 'input[type=radio]')[1];
      guests.checked = true;
      guests.dispatchEvent(new Event('change'));
      const role = all<HTMLSelectElement>(fixture, '#share-link-role')[0];
      role.value = 'EDITOR';
      role.dispatchEvent(new Event('change'));
      typeInto(fixture, '#share-link-expiry', '2099-01-01T10:00');
      typeInto(fixture, '#share-link-password', 'correct horse');
      await fixture.whenStable();

      const post = await create(aShareLink({ role: 'EDITOR', audience: 'GUESTS' }));

      const body = post.request.body as Record<string, unknown>;
      expect(body['audience'], 'audience').toBe('GUESTS');
      expect(body['role'], 'role').toBe('EDITOR');
      expect(body['password'], 'password').toBe('correct horse');
      expect(body['expiresAt'], 'expiry as an instant').toBe(
        new Date('2099-01-01T10:00').toISOString(),
      );
    });

    it('when the password is shorter than 8 characters then an error is shown and nothing is sent', async () => {
      await render();
      typeInto(fixture, '#share-link-password', 'short');
      await fixture.whenStable();

      buttonByText(fixture, 'Create link').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'error').toContain('Between 8 and 128 characters.');
    });

    it('when the expiry is in the past then an error is shown and nothing is sent', async () => {
      await render();
      typeInto(fixture, '#share-link-expiry', '2001-01-01T10:00');
      await fixture.whenStable();

      buttonByText(fixture, 'Create link').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'error').toContain('The expiry must be in the future.');
    });

    it('when the server reports a violation then it is shown at the field and no toast appears', async () => {
      await render();
      buttonByText(fixture, 'Create link').click();
      await settle();

      expectRequest('POST', base).flush(
        aProblem({
          code: 'VALIDATION_FAILED',
          status: 400,
          violations: [{ field: 'password', code: 'Size', message: 'size' }],
        }),
        problemResponse(400, 'Bad Request'),
      );
      await settle();
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=field-error]').length, 'field errors').toBe(1);
    });
  });

  describe('the one-time URL', () => {
    it('when a link was created then its URL and the warning are shown', async () => {
      await render();

      await create();

      expect(all<HTMLInputElement>(fixture, '#share-created-url')[0].value, 'URL').toBe(URL);
      expect(textOf(fixture), 'warning').toContain('this is the only time it is shown');
    });

    it('when Copy is clicked then the URL goes to the clipboard', async () => {
      await render();
      await create();
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });

      buttonByText(fixture, 'Copy').click();
      await settle();
      await fixture.whenStable();
      vi.unstubAllGlobals();

      expect(writeText, 'clipboard').toHaveBeenCalledWith(URL);
      expect(textOf(fixture), 'button').toContain('Copied');
    });

    it('when the clipboard is not available then the URL stays and Copy stays', async () => {
      await render();
      await create();
      vi.stubGlobal('navigator', {});

      buttonByText(fixture, 'Copy').click();
      await settle();
      await fixture.whenStable();
      vi.unstubAllGlobals();

      expect(textOf(fixture), 'button').not.toContain('Copied');
      expect(all(fixture, '#share-created-url').length, 'URL field').toBe(1);
    });

    it('when Done is clicked then the URL is gone', async () => {
      await render();
      await create();

      buttonByText(fixture, 'Done').click();
      await fixture.whenStable();

      expect(all(fixture, '#share-created-url').length, 'URL fields').toBe(0);
      expect(fixture.nativeElement.innerHTML, 'token anywhere in the DOM').not.toContain('TOKEN');
    });

    it('when the URL field is focused then its text is selected', async () => {
      await render();
      await create();
      const field = all<HTMLInputElement>(fixture, '#share-created-url')[0];
      const select = vi.spyOn(field, 'select');

      field.dispatchEvent(new Event('focus'));

      expect(select, 'select').toHaveBeenCalled();
    });
  });

  describe('existing links', () => {
    it('when there are no links then a hint says so', async () => {
      await render();

      expect(all(fixture, '[data-testid=no-links]').length, 'hint').toBe(1);
    });

    it('when links exist then role, audience, expiry, password, uses and state are listed', async () => {
      await render([
        aShareLink({
          id: 'a',
          role: 'EDITOR',
          audience: 'GUESTS',
          passwordProtected: true,
          useCount: 3,
          expiresAt: '2099-01-01T10:00:00Z',
        }),
        aShareLink({ id: 'b', expiresAt: '2001-01-01T10:00:00Z', useCount: 1 }),
        aShareLink({ id: 'c', revokedAt: '2026-11-02T10:00:00Z' }),
      ]);

      const items = all(fixture, 'ul[aria-label="Links"] > li').map(
        (li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      );
      expect(items[0], 'role').toContain('Editor');
      expect(items[0], 'audience').toContain('Guests without account');
      expect(items[0], 'first details').toContain('Password: yes · Used 3 times');
      expect(items[0], 'first state').toContain('Active');
      expect(items[1], 'expired').toContain('Expired');
      expect(items[1], 'single use').toContain('Used 1 time');
      expect(items[1], 'no expiry text').toContain('Password: no');
      expect(items[2], 'revoked').toContain('Revoked');
      expect(items[2], 'expiry never').toContain('Expires: Never');
    });

    it('when a link is revoked or expired already then only active ones offer Revoke', async () => {
      await render([
        aShareLink({ id: 'a' }),
        aShareLink({ id: 'c', revokedAt: '2026-11-02T10:00:00Z' }),
      ]);

      expect(
        all(fixture, 'li button').filter((b) => b.textContent?.trim() === 'Revoke').length,
        'Revoke buttons',
      ).toBe(1);
    });

    it('when Revoke is clicked then a confirmation is asked and nothing is sent yet', async () => {
      await render([aShareLink()]);

      buttonByText(fixture, 'Revoke').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'question').toContain('It stops working for good.');
    });

    it('when the confirmation is cancelled then the link stays', async () => {
      await render([aShareLink()]);
      buttonByText(fixture, 'Revoke').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Cancel').click();
      await fixture.whenStable();

      expect(all(fixture, '[role=group]').length, 'question').toBe(0);
    });

    it('when the revoke is confirmed then the link is deleted and the list reloads', async () => {
      await render([aShareLink()]);
      buttonByText(fixture, 'Revoke').click();
      await fixture.whenStable();

      buttonByText(fixture, 'Yes, revoke').click();
      await settle();
      expectRequest('DELETE', '/api/links/link-1', 'revoke').flush(null, {
        status: 204,
        statusText: 'No Content',
      });
      await settle();
      expectRequest('GET', base, 'reload').flush({
        items: [aShareLink({ revokedAt: '2026-11-10T10:00:00Z' })],
      });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'state').toContain('Revoked');
    });

    it('when the links cannot be loaded then an alert with a retry is shown', async () => {
      const fake = provideFakeAuth();
      fake.auth.signIn('alice');
      TestBed.configureTestingModule({
        providers: [
          provideRouter([{ path: '**', children: [] }]),
          provideHttpTesting(),
          fake.providers,
        ],
      });
      fixture = TestBed.createComponent(ShareLinks, {
        bindings: [inputBinding('kind', () => 'folder'), inputBinding('resourceId', () => 'f1')],
      });
      await settle();
      expectRequest('GET', '/api/folders/f1/links').flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert').toContain('req-500');
    });
  });
});
