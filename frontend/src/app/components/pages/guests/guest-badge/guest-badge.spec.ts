import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GuestSession as GuestSessionDto } from '@apps/drawboard-api';

import { GuestSession } from '../../../../services/guest-session';
import { all, buttonByLabel, textOf } from '../../../../test/dom';
import { provideHttpTesting } from '../../../../test/http-testing';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { GuestBadge } from './guest-badge';

const SESSION: GuestSessionDto = {
  accessToken: 'jwt',
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
  kind: 'BOARD',
  id: 'b1',
  role: 'EDITOR',
  name: 'Guesty',
};

describe('GuestBadge', () => {
  let fixture: ComponentFixture<GuestBadge>;
  let session: GuestSession;

  async function render(startAsGuest = true): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    session = TestBed.inject(GuestSession);
    if (startAsGuest) {
      session.start(SESSION, 'link-token');
    }
    fixture = TestBed.createComponent(GuestBadge);
    await fixture.whenStable();
  }

  afterEach(() => session.clear());

  describe('rendering', () => {
    it('when in guest mode then the Guest badge and the name are shown', async () => {
      await render();

      expect(all(fixture, '[data-testid=guest-badge]')[0].textContent, 'badge').toBe('Guest');
      expect(textOf(fixture), 'name').toContain('Guesty');
    });

    it('when not in guest mode then nothing is shown', async () => {
      await render(false);

      expect(textOf(fixture), 'text').toBe('');
    });
  });

  describe('leaving', () => {
    it('when Leave is clicked then the session is forgotten and the join page opens', async () => {
      await render();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      buttonByLabel(fixture, 'Leave as guest').click();
      await fixture.whenStable();

      expect(session.active(), 'guest mode').toBe(false);
      expect(navigate, 'navigation').toHaveBeenCalledWith(['/s']);
    });
  });
});
