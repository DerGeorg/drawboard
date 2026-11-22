import { GIF_CONSENT_ALWAYS, GIF_CONSENT_KEY, GifConsent } from './gif-consent';

function fakeStorage(
  initial: Record<string, string> = {},
): Storage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage & { data: Map<string, string> };
}

describe('GifConsent (G10)', () => {
  describe('asking', () => {
    it('when nothing was chosen then nothing may load', () => {
      const consent = new GifConsent(fakeStorage());

      expect(consent.allowed('b1'), 'allowed').toBe(false);
      expect(consent.always(), 'always').toBe(false);
      expect(consent.granted(), 'granted').toBe(false);
    });

    it('when the stored value is not exactly "always" then it counts as no consent', () => {
      for (const value of ['true', '1', 'ALWAYS', 'always ', '{"always":true}', '']) {
        const consent = new GifConsent(fakeStorage({ [GIF_CONSENT_KEY]: value }));
        expect(consent.always(), JSON.stringify(value)).toBe(false);
      }
    });

    it('when another tab revokes the consent then the next question sees it', () => {
      const storage = fakeStorage({ [GIF_CONSENT_KEY]: GIF_CONSENT_ALWAYS });
      const consent = new GifConsent(storage);
      expect(consent.always(), 'before').toBe(true);

      storage.data.clear();

      expect(consent.always(), 'after').toBe(false);
    });
  });

  describe('granting', () => {
    it('when "Load" is chosen then only that board loads, and nothing is stored', () => {
      const storage = fakeStorage();
      const consent = new GifConsent(storage);

      consent.allowBoard('b1');

      expect(consent.allowed('b1'), 'this board').toBe(true);
      expect(consent.allowed('b2'), 'another board').toBe(false);
      expect(storage.data.size, 'nothing in the storage').toBe(0);
    });

    it('when "Always" is stored and another tab clears the key then it is not kept alive in memory', () => {
      const storage = fakeStorage();
      const consent = new GifConsent(storage);
      consent.allowAlways();

      storage.data.clear();

      expect(consent.always(), 'revoked from outside').toBe(false);
    });

    it('when "Always in this browser" is chosen then every board loads and one key is stored', () => {
      const storage = fakeStorage();
      const consent = new GifConsent(storage);

      consent.allowAlways();

      expect(consent.allowed('b1') && consent.allowed('b2'), 'any board').toBe(true);
      expect([...storage.data.entries()], 'one key').toEqual([
        [GIF_CONSENT_KEY, GIF_CONSENT_ALWAYS],
      ]);
      expect(new GifConsent(storage).always(), 'a new page in this browser').toBe(true);
    });

    it('when a grant happens then listeners are told', () => {
      const consent = new GifConsent(fakeStorage());
      let changes = 0;
      consent.changed.on(() => changes++);

      consent.allowBoard('b1');
      consent.allowAlways();

      expect(changes, 'changes').toBe(2);
    });
  });

  describe('forgetting', () => {
    it('when the consent is forgotten then both grades go, in the storage and in memory', () => {
      const storage = fakeStorage();
      const consent = new GifConsent(storage);
      consent.allowAlways();
      consent.allowBoard('b1');
      let changes = 0;
      consent.changed.on(() => changes++);

      consent.forget();

      expect(consent.allowed('b1'), 'board').toBe(false);
      expect(consent.always(), 'always').toBe(false);
      expect(storage.data.size, 'storage').toBe(0);
      expect(changes, 'listeners told').toBe(1);
    });

    it('when the storage throws then reading, writing and forgetting still work in memory', () => {
      const blocked = (): never => {
        throw new Error('blocked');
      };
      const broken = {
        getItem: blocked,
        setItem: blocked,
        removeItem: blocked,
      } as unknown as Storage;
      const consent = new GifConsent(broken);

      expect(consent.always(), 'read').toBe(false);
      consent.allowAlways();
      expect(consent.always(), 'held in memory').toBe(true);
      consent.forget();
      expect(consent.always(), 'forgotten').toBe(false);
    });
  });
});
