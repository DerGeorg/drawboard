import { GifSlots, MAX_LOADED_GIFS } from './gif-slots';

describe('GifSlots', () => {
  describe('acquire', () => {
    it('when the limit is reached then there is no slot until one is released, once', () => {
      const slots = new GifSlots(2);
      let freed = 0;
      slots.freed.on(() => freed++);

      const a = slots.acquire();
      const b = slots.acquire();

      expect(slots.acquire(), 'third').toBeUndefined();
      a?.();
      a?.(); // a second release changes nothing
      expect(slots.loaded, 'loaded').toBe(1);
      expect(freed, 'told once').toBe(1);
      expect(slots.acquire(), 'room again').toBeDefined();
      b?.();
    });

    it('when no limit is given then it is 30', () => {
      expect(new GifSlots().max, 'default').toBe(MAX_LOADED_GIFS);
      expect(MAX_LOADED_GIFS, 'the value of G9').toBe(30);
    });
  });
});
