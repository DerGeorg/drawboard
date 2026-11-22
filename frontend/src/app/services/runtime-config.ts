import { InjectionToken } from '@angular/core';

/**
 * Everything that differs between deployments. The pipeline builds ONE image that runs on dev
 * and prod, so none of this may be baked into the bundle: the container serves it as
 * /config.json (deploy/nginx/default.conf.template), main.ts loads it before bootstrap.
 */
export interface RuntimeConfig {
  /** Deployment name: 'local', 'dev', 'prod' - shown in the header, sent to Faro. */
  readonly environment: string;
  /** Image version (APP_VERSION) - footer, Faro release (source map lookup key). */
  readonly version: string;
  /** Base path of the backend API as seen by the browser. Normally '/api' (same origin). */
  readonly apiBaseUrl: string;
  /** Issuer URL of the OIDC provider (discovery below it), e.g. http://localhost:18180/realms/drawboard */
  readonly oidcIssuer: string;
  /** Public SPA client of that provider (authorization code flow + PKCE). */
  readonly oidcClientId: string;
  /** Scopes requested at login; defaults to "openid profile email". */
  readonly oidcScope: string;
  /**
   * Origin the signed file URLs are served from when the deployment has a files origin of its
   * own (`DRAWBOARD_FILES_ORIGIN`, S4.6), e.g. https://files.example.org. Absent = the app
   * origin: the API hands out paths (`/files/...`) and they are used as they are.
   */
  readonly filesOrigin?: string;
  /**
   * Origin plugin assets and frames come from when the deployment has one
   * (`DRAWBOARD_PLUGIN_ORIGIN`, S3.4). Absent = `/plugin-assets/` on the app origin. The plugin
   * host refuses frames from anywhere else.
   */
  readonly pluginOrigin?: string;
  /**
   * Product site (`ABOUT_URL`), absolute https URL: "Host your own" in the footer, the About
   * dialog and the guest line. Absent = the operator switched the promotion off (empty value).
   */
  readonly aboutUrl?: string;
  /**
   * Where the source of THIS deployment is offered (`SOURCE_URL`, AGPL-3.0 section 13), absolute
   * https URL. Never absent: an operator of a modified version points it at their own source.
   */
  readonly sourceUrl: string;
  /**
   * GIFs from GIPHY are switched on for this deployment (`GIFS_ENABLED`, exactly `true`; G3). The
   * same switch adds `https://media.giphy.com` to the CSP `img-src`. Absent or false = GIF blocks
   * are placeholders and there is no GIF picker.
   */
  readonly gifsEnabled?: boolean;
  /** Grafana Faro; absent = no browser telemetry at all. */
  readonly faro?: {
    /** Same-origin collector path, e.g. '/faro/collect' (the image proxies it to Alloy). */
    readonly collectorUrl: string;
    readonly appName: string;
    readonly namespace: string;
    /** Share of page loads that send anything, 0..1. */
    readonly samplingRate: number;
  };
}

/** Build-time settings (src/environments). Everything else is RuntimeConfig. */
export interface Environment {
  readonly production: boolean;
  /** Inline runtime config for `ng serve`; when set, main.ts does not fetch /config.json. */
  readonly runtimeConfig?: RuntimeConfig;
}

export const DEFAULT_OIDC_SCOPE = 'openid profile email';
export const DEFAULT_ABOUT_URL = 'https://drawboard.dergeorg.at';
export const DEFAULT_SOURCE_URL = 'https://github.com/DerGeorg/drawboard';

export const RUNTIME_CONFIG = new InjectionToken<RuntimeConfig>('RUNTIME_CONFIG');

/** Fetches /config.json before Angular boots. Fails loudly: no half-configured app. */
export async function loadRuntimeConfig(url = '/config.json'): Promise<RuntimeConfig> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Runtime config ${url} could not be loaded: HTTP ${response.status}`);
  }
  return normalizeRuntimeConfig(await response.json());
}

type RawRuntimeConfig = Partial<Omit<RuntimeConfig, 'faro' | 'gifsEnabled'>> & {
  /** nginx writes a JSON boolean; whatever else arrives (a string, a number) is not "on". */
  gifsEnabled?: unknown;
  faro?: Partial<Record<keyof NonNullable<RuntimeConfig['faro']>, string | number>>;
};

/**
 * nginx renders every key of the template, unset variables as "" and numbers as strings.
 * Required values are checked here, an empty Faro block becomes `undefined`.
 */
export function normalizeRuntimeConfig(raw: RawRuntimeConfig): RuntimeConfig {
  const missing = [
    ['environment', raw.environment],
    ['apiBaseUrl', raw.apiBaseUrl],
    ['oidcIssuer', raw.oidcIssuer],
    ['oidcClientId', raw.oidcClientId],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Runtime config is missing ${missing.join(', ')}`);
  }
  const faro = raw.faro;
  const samplingRate = Number(faro?.samplingRate === '' ? 1 : (faro?.samplingRate ?? 1));
  return {
    environment: raw.environment as string,
    version: raw.version || 'unknown',
    apiBaseUrl: (raw.apiBaseUrl as string).replace(/\/$/, ''),
    oidcIssuer: (raw.oidcIssuer as string).replace(/\/$/, ''),
    oidcClientId: raw.oidcClientId as string,
    oidcScope: raw.oidcScope || DEFAULT_OIDC_SCOPE,
    filesOrigin: origin(raw.filesOrigin, 'filesOrigin'),
    pluginOrigin: origin(raw.pluginOrigin, 'pluginOrigin'),
    aboutUrl: aboutUrl(raw.aboutUrl),
    sourceUrl: httpsUrl(raw.sourceUrl) ?? DEFAULT_SOURCE_URL,
    // fail closed (G3): only the boolean true switches GIFs on
    gifsEnabled: raw.gifsEnabled === true,
    faro: faro?.collectorUrl
      ? {
          collectorUrl: String(faro.collectorUrl),
          appName: String(faro.appName || 'frontend'),
          namespace: String(faro.namespace || ''),
          samplingRate: Number.isFinite(samplingRate) ? Math.min(Math.max(samplingRate, 0), 1) : 1,
        }
      : undefined,
  };
}

/**
 * An optional origin from the config: empty = absent; anything but `scheme://host[:port]`
 * stops the app (a path or a typo here would send file URLs or plugin frames elsewhere).
 */
function origin(value: string | undefined, key: string): string | undefined {
  const trimmed = value?.trim().replace(/\/$/, '');
  if (!trimmed) {
    return undefined;
  }
  if (!/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(trimmed)) {
    throw new Error(`Runtime config ${key} must be an origin like https://host[:port]`);
  }
  return trimmed.toLowerCase();
}

/**
 * `aboutUrl`: absent (key missing) = the default; an empty value switches the promotion off;
 * anything that is not an absolute https URL falls back to the default.
 */
function aboutUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return DEFAULT_ABOUT_URL;
  }
  return value.trim() === '' ? undefined : (httpsUrl(value) ?? DEFAULT_ABOUT_URL);
}

/** An absolute https URL without credentials, as written (trimmed); anything else is undefined. */
function httpsUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    const valid =
      url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
    return valid ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
