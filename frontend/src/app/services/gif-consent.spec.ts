import { TestBed } from '@angular/core/testing';

import { GIF_CONSENT_KEY } from '../../board-engine/gifs/gif-consent';
import { GifConsentStore } from './gif-consent';

describe('GifConsentStore', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  describe('other tabs', () => {
    it('when another tab changes the consent key then the views are told and the signals follow', () => {
      const store = TestBed.inject(GifConsentStore);
      store.allowAlways();
      let told = 0;
      store.changed.on(() => told++);
      const revision = store.revision();

      localStorage.removeItem(GIF_CONSENT_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: GIF_CONSENT_KEY, newValue: null }));

      expect(told, 'told').toBe(1);
      expect(store.revision(), 'revision').toBe(revision + 1);
      expect(store.remembered(), 'forgotten').toBe(false);
    });

    it('when another key changes then nothing happens, and a cleared storage counts', () => {
      const store = TestBed.inject(GifConsentStore);
      let told = 0;
      store.changed.on(() => told++);

      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
      expect(told, 'other key').toBe(0);

      window.dispatchEvent(new StorageEvent('storage', { key: null }));
      expect(told, 'clear()').toBe(1);
    });

    it('when the store is destroyed then it no longer listens', () => {
      const store = TestBed.inject(GifConsentStore);
      let told = 0;
      store.changed.on(() => told++);

      TestBed.resetTestingModule();
      window.dispatchEvent(new StorageEvent('storage', { key: GIF_CONSENT_KEY }));

      expect(told, 'not told').toBe(0);
    });
  });

  describe('state', () => {
    it('when the browser remembered "always" then the store starts with it', () => {
      localStorage.setItem(GIF_CONSENT_KEY, 'always');

      const store = TestBed.inject(GifConsentStore);

      expect(store.remembered(), 'remembered').toBe(true);
      expect(store.allowed('any-board'), 'allowed').toBe(true);
    });

    it('when consent is given and forgotten then the signals follow', () => {
      const store = TestBed.inject(GifConsentStore);
      const start = store.revision();

      store.allowAlways();
      expect(store.remembered(), 'after always').toBe(true);

      store.forget();
      expect(store.remembered(), 'after forget').toBe(false);
      expect(store.revision(), 'revision counted both').toBe(start + 2);
      expect(localStorage.getItem(GIF_CONSENT_KEY), 'key removed').toBeNull();
    });

    it('when the board consent is given then it is not remembered', () => {
      const store = TestBed.inject(GifConsentStore);

      store.allowBoard('b1');

      expect(store.remembered(), 'not remembered').toBe(false);
      expect(store.granted(), 'but granted').toBe(true);
      expect(localStorage.getItem(GIF_CONSENT_KEY), 'nothing stored').toBeNull();
    });
  });
});
