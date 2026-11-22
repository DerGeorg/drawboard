import { inputBinding, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import type { ProviderState } from '@apps/drawboard-engine';
import { BoardConnection } from './board-connection';

describe('BoardConnection', () => {
  const state = signal<ProviderState | undefined>(undefined);

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(BoardConnection, {
      bindings: [inputBinding('state', state)],
    });
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const aState = (patch: Partial<ProviderState>): ProviderState => ({
    status: 'synced',
    role: 'EDITOR',
    error: undefined,
    closeCode: undefined,
    reloadRequired: false,
    ...patch,
  });

  beforeEach(() => state.set(undefined));

  describe('rendering', () => {
    it('when there is no connection yet then nothing is shown', () => {
      const el = render();

      expect(el.querySelector('[data-testid="connection"]'), 'badge').toBeNull();
    });

    it.each([
      ['synced', 'Live'],
      ['readonly', 'Live, read only'],
      ['connecting', 'Connecting…'],
      ['offline', 'Offline'],
      ['full', 'Board full'],
      ['denied', 'No access'],
    ] as const)('when the status is %s then the badge reads "%s"', (status, label) => {
      state.set(aState({ status }));

      const badge = render().querySelector('[data-testid="connection"]');

      expect(badge?.textContent?.trim(), 'label').toBe(label);
      expect(badge?.getAttribute('title'), 'hint').toBeTruthy();
    });

    it('when an update was too large then the hint asks for a reload', () => {
      state.set(aState({ reloadRequired: true }));

      const badge = render().querySelector('[data-testid="connection"]');

      expect(badge?.getAttribute('title'), 'hint').toContain('Reload');
    });

    it('when the status is shown then a dot for small screens carries the same label', () => {
      state.set(aState({ status: 'offline' }));

      const dot = render().querySelector('[data-testid="connection-dot"]');

      expect(dot?.getAttribute('aria-label'), 'label').toBe('Offline');
    });
  });
});
