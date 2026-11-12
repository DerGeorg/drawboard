import { inputBinding, outputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import type { SummonState } from '../../../../../board-engine/collab/awareness-state';
import type { Following } from '../../../../../board-engine/collab/follow';
import type { PeerPresence } from '../../../../../board-engine/presence';
import { all, buttonByText, textOf } from '../../../../test/dom';
import { BoardFollowBar } from './board-follow-bar';

describe('BoardFollowBar', () => {
  let fixture: ComponentFixture<BoardFollowBar>;
  const following = signal<Following | null>(null);
  const presenting = signal<SummonState | null>(null);
  const followers = signal<PeerPresence[]>([]);
  const stop = vi.fn();
  const end = vi.fn();
  const ignore = vi.fn();

  const bob = (mode: Following['mode'], color = '#2563eb'): Following => ({
    clientId: 2,
    userId: 'id-bob',
    name: 'Bob',
    color,
    mode,
  });
  const aFollower = (n: number): PeerPresence => ({
    clientId: n,
    userId: `u${n}`,
    name: `Person ${n}`,
    color: '#2563eb',
    guest: false,
    role: 'EDITOR',
    cursor: null,
    selection: [],
    viewport: null,
    following: 1,
    summon: null,
  });

  beforeEach(async () => {
    following.set(null);
    presenting.set(null);
    followers.set([]);
    [stop, end, ignore].forEach((f) => f.mockClear());
    fixture = TestBed.createComponent(BoardFollowBar, {
      bindings: [
        inputBinding('following', following),
        inputBinding('presenting', presenting),
        inputBinding('followers', followers),
        outputBinding('stop', stop),
        outputBinding('endPresenting', end),
        outputBinding('ignore', ignore),
      ],
    });
    await fixture.whenStable();
  });

  describe('following and presenting', () => {
    it('when nothing is going on then nothing is shown', () => {
      expect(textOf(fixture).trim(), 'empty').toBe('');
    });

    it('when following someone then a frame in their colour, their name and Stop are shown', async () => {
      following.set(bob('manual'));
      await fixture.whenStable();

      expect(textOf(fixture), 'label').toContain('Following Bob');
      expect(all(fixture, '[data-testid=follow-frame]')[0]?.style.borderColor, 'colour').toBe(
        'rgb(37, 99, 235)',
      );
      buttonByText(fixture, 'Stop').click();
      expect(stop, 'stop').toHaveBeenCalledTimes(1);
    });

    it('when the colour is not a plain hex colour then the fallback is used (S5.2)', async () => {
      following.set(bob('manual', 'url(https://evil.example/x)'));
      await fixture.whenStable();

      expect(
        all(fixture, '[data-testid=follow-frame]')[0]?.style.borderColor,
        'colour',
      ).not.toContain('url');
    });

    it('when summoned then it says who presents and offers Ignore', async () => {
      following.set(bob('summoned'));
      await fixture.whenStable();

      expect(textOf(fixture), 'label').toContain("Bob is presenting - you're following");
      buttonByText(fixture, 'Ignore').click();
      expect(ignore, 'ignore').toHaveBeenCalledWith(expect.objectContaining({ userId: 'id-bob' }));
    });

    it('when Escape is pressed while following then following stops; otherwise Escape does nothing', async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(stop, 'not following').not.toHaveBeenCalled();

      following.set(bob('manual'));
      await fixture.whenStable();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(stop, 'stopped').toHaveBeenCalledTimes(1);
    });

    it('when presenting then the followers are named and End ends it', async () => {
      presenting.set({ id: 1, targets: 'all' });
      await fixture.whenStable();
      expect(textOf(fixture), 'nobody yet').toContain('nobody follows yet');

      followers.set([1, 2, 3, 4].map(aFollower));
      await fixture.whenStable();
      expect(textOf(fixture), 'names').toContain('4 following: Person 1, Person 2, Person 3 +1');

      buttonByText(fixture, 'End').click();
      expect(end, 'end').toHaveBeenCalledTimes(1);
    });
  });
});
