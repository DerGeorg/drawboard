import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import type { ProviderState } from '../../../../../board-engine/collab/provider';
import { PeerPresence } from '../../../../../board-engine/presence';
import { provideRouter } from '@angular/router';

import { all, buttonByLabel, textOf } from '../../../../test/dom';
import { provideFakeAuth } from '../../../../test/fake-auth';
import { provideHttpTesting } from '../../../../test/http-testing';
import { BoardParticipants, MAX_AVATARS } from './board-participants';

describe('BoardParticipants', () => {
  let fixture: ComponentFixture<BoardParticipants>;
  const peers = signal<PeerPresence[]>([]);
  const selfName = signal<string | undefined>('Alice Admin');
  const state = signal<ProviderState | undefined>(undefined);
  const share = vi.fn();
  const guest = signal(false);
  const following = signal<number | null>(null);
  const canPresent = signal(false);
  const ignored = signal<ReadonlySet<string>>(new Set());
  const follow = vi.fn();
  const stopFollowing = vi.fn();
  const summon = vi.fn();
  const ignore = vi.fn();
  const unignore = vi.fn();

  const aPeer = (n: number, color = '#2563eb'): PeerPresence => ({
    clientId: n,
    userId: `user-${n}`,
    name: `Person ${n}`,
    color,
    guest: false,
    role: 'EDITOR',
    cursor: null,
    selection: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    following: null,
    summon: null,
  });

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(BoardParticipants, {
      bindings: [
        inputBinding('peers', peers),
        inputBinding('selfName', selfName),
        inputBinding('state', state),
        inputBinding('guest', guest),
        inputBinding('following', following),
        inputBinding('canPresent', canPresent),
        inputBinding('ignored', ignored),
        outputBinding('share', share),
        outputBinding('follow', follow),
        outputBinding('stopFollowing', stopFollowing),
        outputBinding('summon', summon),
        outputBinding('ignore', ignore),
        outputBinding('unignore', unignore),
      ],
    });
    await fixture.whenStable();
  }

  const avatars = (): HTMLElement[] => all(fixture, 'drawboard-avatar [role=img]');

  beforeEach(() => {
    peers.set([]);
    selfName.set('Alice Admin');
    state.set(undefined);
    share.mockClear();
    guest.set(false);
    following.set(null);
    canPresent.set(false);
    ignored.set(new Set());
    [follow, stopFollowing, summon, ignore, unignore].forEach((f) => f.mockClear());
  });

  const menuItems = (): string[] =>
    all(fixture, '[role=menuitem]').map((b) => (b.textContent ?? '').trim());
  const menuItem = (text: string): HTMLButtonElement =>
    all<HTMLButtonElement>(fixture, '[role=menuitem]').find(
      (b) => (b.textContent ?? '').trim() === text,
    ) as HTMLButtonElement;

  describe('follow and present', () => {
    it('when an avatar is clicked then its menu offers Follow, and Follow emits the person', async () => {
      peers.set([aPeer(2)]);
      await render();

      buttonByLabel(fixture, 'Options for Person 2').click();
      await fixture.whenStable();

      expect(menuItems(), 'items of a viewer').toEqual(['Follow', 'Ignore their summons']);
      menuItem('Follow').click();
      await fixture.whenStable();
      expect(follow, 'follow').toHaveBeenCalledWith(expect.objectContaining({ clientId: 2 }));
      expect(menuItems(), 'menu closed').toEqual([]);
    });

    it('when I already follow the person then the item stops following', async () => {
      peers.set([aPeer(2)]);
      following.set(2);
      await render();

      buttonByLabel(fixture, 'Options for Person 2').click();
      await fixture.whenStable();
      menuItem('Stop following').click();

      expect(stopFollowing, 'stop').toHaveBeenCalledTimes(1);
    });

    it('when I may present then I can ask one person or everyone to follow me', async () => {
      peers.set([aPeer(2), aPeer(3)]);
      canPresent.set(true);
      await render();

      buttonByLabel(fixture, 'Options for Person 3').click();
      await fixture.whenStable();
      menuItem('Ask to follow me').click();
      buttonByLabel(fixture, 'Bring everyone to me').click();

      expect(summon.mock.calls, 'summons').toEqual([[[3]], ['all']]);
    });

    it('when I may not present then neither summon control is offered', async () => {
      peers.set([aPeer(2)]);
      await render();

      buttonByLabel(fixture, 'Options for Person 2').click();
      await fixture.whenStable();

      expect(all(fixture, '[aria-label="Bring everyone to me"]').length, 'bring all').toBe(0);
      expect(menuItems(), 'items').not.toContain('Ask to follow me');
    });

    it('when a person is ignored then their item undoes it; guests have no ignore item', async () => {
      peers.set([aPeer(2), { ...aPeer(3), guest: true }]);
      await render();
      buttonByLabel(fixture, 'Options for Person 2').click();
      await fixture.whenStable();
      menuItem('Ignore their summons').click();
      expect(ignore, 'ignore').toHaveBeenCalledWith(expect.objectContaining({ clientId: 2 }));

      ignored.set(new Set(['user-2']));
      buttonByLabel(fixture, 'Options for Person 2').click();
      await fixture.whenStable();
      menuItem('Allow their summons again').click();
      expect(unignore, 'unignore').toHaveBeenCalledWith(expect.objectContaining({ clientId: 2 }));
      expect(ignore, 'ignore not again').toHaveBeenCalledTimes(1);

      buttonByLabel(fixture, 'Options for Person 3').click();
      await fixture.whenStable();
      expect(menuItems(), 'guest items').toEqual(['Follow']);
    });

    it('when a person has published no viewport yet then Follow is disabled', async () => {
      peers.set([{ ...aPeer(2), viewport: null }]);
      await render();

      buttonByLabel(fixture, 'Options for Person 2').click();
      await fixture.whenStable();

      expect(menuItem('Follow').disabled, 'disabled').toBe(true);
    });

    it('when the "+n" bubble is clicked then the hidden people are listed and open their menu', async () => {
      peers.set([1, 2, 3, 4, 5].map((n) => aPeer(n + 1)));
      await render();

      buttonByLabel(fixture, 'More people').click();
      await fixture.whenStable();
      expect(menuItems(), 'hidden').toEqual(['Person 5', 'Person 6']);

      menuItem('Person 6').click();
      await fixture.whenStable();
      expect(menuItems(), 'menu of Person 6').toContain('Follow');
    });
  });

  describe('avatars', () => {
    it('when you are alone then only your own avatar is shown', async () => {
      await render();

      expect(
        avatars().map((a) => a.getAttribute('aria-label')),
        'avatars',
      ).toEqual(['Alice Admin (you)']);
    });

    it('when others are present then they follow with their initials and server colour', async () => {
      peers.set([aPeer(2, '#e8590c')]);
      await render();

      const other = avatars()[1] as HTMLElement;
      expect(other.textContent, 'initials').toBe('P2');
      expect(other.style.backgroundColor, 'colour').toBe('rgb(232, 89, 12)');
    });

    it('when a colour from the server is not a plain hex colour then the fallback colour is used', async () => {
      peers.set([aPeer(2, 'url(https://attacker.example/x.png)')]);
      await render();

      expect((avatars()[1] as HTMLElement).style.backgroundColor, 'colour').not.toContain('url');
    });

    it('when more people are present than fit then the rest is summarised as "+n"', async () => {
      peers.set([1, 2, 3, 4, 5, 6].map((n) => aPeer(n)));
      await render();

      expect(avatars().length, 'avatars drawn').toBe(MAX_AVATARS);
      expect(textOf(fixture), 'overflow').toContain('+3');
      expect(all(fixture, '[data-testid=overflow]')[0]?.getAttribute('title'), 'hidden names').toBe(
        'Person 4, Person 5, Person 6',
      );
    });

    it('when nobody is known then no avatar list is rendered', async () => {
      selfName.set(undefined);
      await render();

      expect(avatars().length, 'avatars').toBe(0);
    });
  });

  describe('status and share', () => {
    it('when the connection is live then its badge is shown', async () => {
      state.set({
        status: 'synced',
        role: 'EDITOR',
        error: undefined,
        closeCode: undefined,
        reloadRequired: false,
      });
      await render();

      expect(textOf(fixture), 'badge').toContain('Live');
    });

    it('when Share is clicked then share is emitted', async () => {
      await render();

      buttonByLabel(fixture, 'Share').click();

      expect(share, 'emitted').toHaveBeenCalledTimes(1);
    });
  });

  describe('guests', () => {
    it('when a peer is a guest then the avatar carries a G marker and the label says guest', async () => {
      peers.set([{ ...aPeer(2), guest: true }, aPeer(3)]);
      await render();

      expect(all(fixture, '[data-testid=guest-marker]').length, 'markers').toBe(1);
      expect(avatars()[1].getAttribute('aria-label'), 'label of the guest').toBe(
        'Person 2 (guest)',
      );
      expect(avatars()[2].getAttribute('aria-label'), 'label of a member').toBe('Person 3');
    });

    it('when the viewer is a guest then a Guest badge replaces the Share button', async () => {
      guest.set(true);
      TestBed.configureTestingModule({
        providers: [provideRouter([]), provideHttpTesting(), provideFakeAuth().providers],
      });
      await render();

      expect(all(fixture, 'button[aria-label=Share]').length, 'share buttons').toBe(0);
      expect(all(fixture, 'drawboard-guest-badge').length, 'badges').toBe(1);
      expect(all(fixture, '[data-testid=guest-marker]').length, 'own marker').toBe(1);
    });
  });
});
