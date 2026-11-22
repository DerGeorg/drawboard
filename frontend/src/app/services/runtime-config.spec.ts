import {
  DEFAULT_ABOUT_URL,
  DEFAULT_SOURCE_URL,
  loadRuntimeConfig,
  normalizeRuntimeConfig,
} from './runtime-config';

describe('runtime-config', () => {
  const complete = {
    environment: 'dev',
    version: '1.4.0',
    apiBaseUrl: '/api/',
    oidcIssuer: 'https://auth.example/realms/dergeorg/',
    oidcClientId: 'drawboard-web',
    oidcScope: '',
    faro: {
      collectorUrl: '/faro/collect',
      appName: 'drawboard-frontend',
      namespace: 'drawboard',
      samplingRate: '0.5',
    },
  };

  describe('normalizeRuntimeConfig', () => {
    it('when every value is set then numbers are parsed and the trailing slash is dropped', () => {
      const config = normalizeRuntimeConfig(complete);

      expect(config.apiBaseUrl, 'API base URL').toBe('/api');
      expect(config.faro, 'Faro block').toEqual({
        collectorUrl: '/faro/collect',
        appName: 'drawboard-frontend',
        namespace: 'drawboard',
        samplingRate: 0.5,
      });
    });

    it('when the Faro collector is empty then Faro is off', () => {
      const config = normalizeRuntimeConfig({
        ...complete,
        faro: { ...complete.faro, collectorUrl: '' },
      });

      expect(config.faro, 'Faro block without collector').toBeUndefined();
    });

    it('when the sampling rate is empty or out of range then it is 1 or clamped', () => {
      const empty = normalizeRuntimeConfig({
        ...complete,
        faro: { ...complete.faro, samplingRate: '' },
      });
      const tooHigh = normalizeRuntimeConfig({
        ...complete,
        faro: { ...complete.faro, samplingRate: '7' },
      });

      expect(empty.faro?.samplingRate, 'sampling rate when empty').toBe(1);
      expect(tooHigh.faro?.samplingRate, 'sampling rate above 1').toBe(1);
    });

    it('when the version is empty then it reads unknown', () => {
      expect(normalizeRuntimeConfig({ ...complete, version: '' }).version, 'version').toBe(
        'unknown',
      );
    });

    it('when the issuer is missing then the error names it', () => {
      const withoutIssuer = { ...complete, oidcIssuer: '' };

      expect(() => normalizeRuntimeConfig(withoutIssuer), 'config without issuer').toThrow(
        /oidcIssuer/,
      );
    });

    it('when the client id is missing then the error names it', () => {
      const withoutClient = { ...complete, oidcClientId: '' };

      expect(() => normalizeRuntimeConfig(withoutClient), 'config without client id').toThrow(
        /oidcClientId/,
      );
    });

    it('when the scope is empty then the default scope is used and the issuer loses its trailing slash', () => {
      const config = normalizeRuntimeConfig(complete);

      expect(config.oidcScope, 'scope').toBe('openid profile email');
      expect(config.oidcIssuer, 'issuer').toBe('https://auth.example/realms/dergeorg');
    });

    it('when a scope is configured then it is kept', () => {
      const config = normalizeRuntimeConfig({ ...complete, oidcScope: 'openid offline_access' });

      expect(config.oidcScope, 'scope').toBe('openid offline_access');
    });

    it('when the files and plugin origins are empty then they are absent', () => {
      const config = normalizeRuntimeConfig({ ...complete, filesOrigin: '', pluginOrigin: ' ' });

      expect(config.filesOrigin, 'files origin').toBeUndefined();
      expect(config.pluginOrigin, 'plugin origin').toBeUndefined();
    });

    it('when the files and plugin origins are set then they lose a trailing slash', () => {
      const config = normalizeRuntimeConfig({
        ...complete,
        filesOrigin: 'https://Files.Example.org/',
        pluginOrigin: 'https://plugins.example.org:8443',
      });

      expect(config.filesOrigin, 'files origin').toBe('https://files.example.org');
      expect(config.pluginOrigin, 'plugin origin').toBe('https://plugins.example.org:8443');
    });

    it('when an origin carries a path then the config is refused', () => {
      expect(
        () => normalizeRuntimeConfig({ ...complete, pluginOrigin: 'https://evil.example/x' }),
        'path',
      ).toThrow(/pluginOrigin/);
      expect(
        () => normalizeRuntimeConfig({ ...complete, filesOrigin: 'javascript:alert(1)' }),
        'scheme',
      ).toThrow(/filesOrigin/);
    });
  });

  describe('gifsEnabled (G3)', () => {
    it('when nginx writes the boolean true then GIFs are on', () => {
      expect(normalizeRuntimeConfig({ ...complete, gifsEnabled: true }).gifsEnabled, 'on').toBe(
        true,
      );
    });

    it.each([false, 'true', 'TRUE', 'false', '', 1, 0, null, undefined, {}, [true]])(
      'when the value is %j then GIFs are off (fail closed)',
      (value) => {
        expect(normalizeRuntimeConfig({ ...complete, gifsEnabled: value }).gifsEnabled, 'off').toBe(
          false,
        );
      },
    );

    it('when the key is missing (an older image) then GIFs are off', () => {
      expect(normalizeRuntimeConfig(complete).gifsEnabled, 'off without the key').toBe(false);
    });
  });

  describe('aboutUrl and sourceUrl', () => {
    it('when both keys are absent then the defaults apply', () => {
      const config = normalizeRuntimeConfig(complete);

      expect(config.aboutUrl, 'about URL').toBe(DEFAULT_ABOUT_URL);
      expect(config.sourceUrl, 'source URL').toBe(DEFAULT_SOURCE_URL);
      expect(DEFAULT_ABOUT_URL, 'default about URL').toBe('https://drawboard.dergeorg.at');
      expect(DEFAULT_SOURCE_URL, 'default source URL').toBe(
        'https://github.com/DerGeorg/drawboard',
      );
    });

    it('when both are absolute https URLs then they are kept as written', () => {
      const config = normalizeRuntimeConfig({
        ...complete,
        aboutUrl: ' https://draw.example.org/about?x=1 ',
        sourceUrl: 'https://git.example.org/me/drawboard-fork',
      });

      expect(config.aboutUrl, 'about URL').toBe('https://draw.example.org/about?x=1');
      expect(config.sourceUrl, 'source URL').toBe('https://git.example.org/me/drawboard-fork');
    });

    it('when aboutUrl is empty then the promotion is off and the source stays', () => {
      const config = normalizeRuntimeConfig({ ...complete, aboutUrl: '', sourceUrl: '' });

      expect(config.aboutUrl, 'about URL').toBeUndefined();
      expect(config.sourceUrl, 'empty source URL falls back to the default').toBe(
        DEFAULT_SOURCE_URL,
      );
    });

    it.each([
      'http://insecure.example.org',
      'javascript:alert(1)',
      'data:text/html,x',
      '//example.org/x',
      '/relative/path',
      'not a url',
      'https://',
      'https://user:secret@example.org',
      'invalid',
      '${ABOUT_URL}',
    ])('when the value is "%s" then both fall back to their defaults', (value) => {
      const config = normalizeRuntimeConfig({ ...complete, aboutUrl: value, sourceUrl: value });

      expect(config.aboutUrl, 'about URL').toBe(DEFAULT_ABOUT_URL);
      expect(config.sourceUrl, 'source URL').toBe(DEFAULT_SOURCE_URL);
    });
  });

  describe('loadRuntimeConfig', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('when /config.json answers then the normalized config is returned', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(complete)));
      vi.stubGlobal('fetch', fetchMock);

      const config = await loadRuntimeConfig();

      expect(fetchMock, 'fetch of the config').toHaveBeenCalledWith('/config.json', {
        cache: 'no-store',
      });
      expect(config.environment, 'environment').toBe('dev');
    });

    it('when /config.json fails then loading fails with the status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));

      await expect(loadRuntimeConfig(), 'failed config load').rejects.toThrow(/HTTP 404/);
    });
  });
});
