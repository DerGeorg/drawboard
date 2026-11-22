/**
 * The host side of the plugin protocol (api `docs/plugin-protocol.md`, plugin API 1.0.0):
 * types, limits and the validation of every message a plugin frame sends (S3.7, S3.8). Pure
 * functions without DOM; the instance (plugin-instance.ts) applies them.
 */

export const PLUGIN_API_VERSION = '1.0.0';
export const PROTOCOL_MAJOR = 1;

/** The limits of the protocol (section "Limits"). */
export const LIMITS = {
  messageBytes: 256 * 1024,
  messagesPerSecond: 100,
  burst: 100,
  pendingRequests: 32,
  droppedPerMinute: 500,
  readyMs: 10_000,
  answerMs: 10_000,
  propsBytes: 64 * 1024,
  storageBytes: 1_048_576,
  storageValueBytes: 200 * 1024,
  toastChars: 200,
  linkChars: 2048,
  boardReadPage: 500,
  framesPerBoard: 50,
  storageRetries: 3,
} as const;

export type CapabilityName =
  | 'block.props'
  | 'block.resize'
  | 'board.read'
  | 'export.register'
  | 'import.register'
  | 'ui.toast'
  | 'ui.openLink'
  | 'storage'
  | 'network';

export const CAPABILITIES: readonly CapabilityName[] = [
  'block.props',
  'block.resize',
  'board.read',
  'export.register',
  'import.register',
  'ui.toast',
  'ui.openLink',
  'storage',
  'network',
];

export interface Capability {
  readonly name: CapabilityName;
  readonly value?: string;
}

export type ErrorCode =
  | 'INVALID_PAYLOAD'
  | 'CAPABILITY_NOT_GRANTED'
  | 'NOT_ALLOWED'
  | 'TOO_LARGE'
  | 'TOO_MANY_REQUESTS'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'UNAVAILABLE'
  | 'TIMEOUT';

/** A failed request; `message` is English text for plugin developers. */
export class PluginError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message.slice(0, 500));
    this.name = 'PluginError';
  }
}

export interface Envelope {
  readonly type: string;
  readonly v: number;
  readonly requestId?: string;
  readonly payload: Record<string, unknown>;
}

/** Plugin → host requests, with the capability each one needs. */
export const REQUESTS: Readonly<Record<string, CapabilityName>> = {
  'block.setProps': 'block.props',
  'block.resize': 'block.resize',
  'board.read': 'board.read',
  'export.register': 'export.register',
  'import.register': 'import.register',
  'ui.toast': 'ui.toast',
  'ui.openLink': 'ui.openLink',
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.keys': 'storage',
};

/** Plugin → host events. */
export const EVENTS: ReadonlySet<string> = new Set(['ready']);

const TYPE = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)*$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ENVELOPE_KEYS = new Set(['type', 'v', 'requestId', 'payload']);
export const STORAGE_KEY = /^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9._:-]{1,128}$/;
export const PLUGIN_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Member names that are invalid at every depth of props, storage values and messages (S3.7). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * True for plain JSON data only: null, booleans, finite numbers, strings, arrays and objects
 * whose prototype is Object.prototype or null - no Blob, ArrayBuffer, Date, Map, ports. Depth
 * is bounded so a deeply nested message cannot blow the stack. The member names `__proto__`,
 * `constructor` and `prototype` are invalid at every depth - this one check guards every sink
 * (messages, props, storage values).
 */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 64) {
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((v) => isPlainJson(v, depth + 1));
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return false;
    }
    return Object.entries(value as object).every(
      ([k, v]) => !isForbiddenKey(k) && isPlainJson(v, depth + 1),
    );
  }
  return false;
}

/**
 * False as soon as a lower bound of the JSON size of `value` passes `limit` bytes. The bound
 * counts only what every JSON text needs at least (a string unit is at least one byte, an
 * element or member a separator), so it never refuses a message that fits, but it stops after
 * about `limit` units of work: a 10 MB string is one comparison, an array of millions of
 * elements ends after a quarter million. Run it before `isPlainJson` and `jsonBytes` (S3.7);
 * the exact size is still measured with `jsonBytes` on whatever survives.
 */
export function withinBound(value: unknown, limit: number): boolean {
  let bytes = 0;
  const walk = (v: unknown, depth: number): boolean => {
    if (bytes > limit || depth > 64) {
      return false;
    }
    if (typeof v === 'string') {
      bytes += v.length + 2;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      bytes += 1;
    } else if (Array.isArray(v)) {
      bytes += 2;
      for (const item of v) {
        bytes += 1;
        if (!walk(item, depth + 1)) {
          return false;
        }
      }
    } else if (typeof v === 'object') {
      bytes += 2;
      for (const key of Object.keys(v)) {
        bytes += key.length + 4;
        if (!walk((v as Record<string, unknown>)[key], depth + 1)) {
          return false;
        }
      }
    }
    return bytes <= limit;
  };
  return walk(value, 0);
}

/** UTF-8 bytes of the JSON of `value` (the size every limit of the protocol is measured in). */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value) ?? '';
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
    } else if (c < 0x800) {
      bytes += 2;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The envelope rules: exactly the four members, `type` and `requestId` patterns, `v` = 1, an
 * object as payload. Returns undefined for anything else (the caller drops and counts it).
 */
export function parseEnvelope(data: unknown): Envelope | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  for (const key of Object.keys(data)) {
    if (!ENVELOPE_KEYS.has(key)) {
      return undefined;
    }
  }
  const { type, v, requestId, payload } = data;
  if (typeof type !== 'string' || type.length > 64 || !TYPE.test(type)) {
    return undefined;
  }
  if (v !== PROTOCOL_MAJOR || !isRecord(payload)) {
    return undefined;
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))) {
    return undefined;
  }
  return { type, v, requestId: requestId as string | undefined, payload };
}

function invalid(what: string): never {
  throw new PluginError('INVALID_PAYLOAD', what);
}

function intIn(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return invalid(`${what} must be an integer from ${min} to ${max}`);
  }
  return v;
}

function onlyKeys(payload: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(payload)) {
    if (!keys.includes(key)) {
      invalid(`unknown member ${key.slice(0, 40)}`);
    }
  }
}

/** Typed, validated payloads of the requests (throws PluginError INVALID_PAYLOAD). */
export const PAYLOADS = {
  'block.setProps'(p: Record<string, unknown>): { props: Record<string, unknown> } {
    onlyKeys(p, ['props']);
    if (!isRecord(p['props'])) {
      return invalid('props must be an object');
    }
    return { props: p['props'] };
  },
  'block.resize'(p: Record<string, unknown>): { width: number; height: number } {
    onlyKeys(p, ['width', 'height']);
    return {
      width: intIn(p['width'], 16, 4096, 'width'),
      height: intIn(p['height'], 16, 4096, 'height'),
    };
  },
  'board.read'(p: Record<string, unknown>): { cursor?: string } {
    onlyKeys(p, ['cursor']);
    const cursor = p['cursor'];
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d{1,6}$/.test(cursor))) {
      return invalid('cursor must be a cursor from an earlier answer');
    }
    return { cursor: cursor as string | undefined };
  },
  'export.register'(p: Record<string, unknown>): Record<string, unknown> {
    onlyKeys(p, ['formats']);
    if (!Array.isArray(p['formats'])) {
      return invalid('formats must be a list');
    }
    return p;
  },
  'import.register'(p: Record<string, unknown>): { mediaType: string } {
    onlyKeys(p, ['mediaType', 'label', 'extensions']);
    const mediaType = p['mediaType'];
    if (typeof mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mediaType)) {
      return invalid('mediaType must be a media type');
    }
    return { mediaType };
  },
  'ui.toast'(p: Record<string, unknown>): {
    level: 'info' | 'success' | 'warning' | 'error';
    message: string;
  } {
    onlyKeys(p, ['level', 'message']);
    const level = p['level'];
    const message = p['message'];
    if (level !== 'info' && level !== 'success' && level !== 'warning' && level !== 'error') {
      return invalid('level must be info, success, warning or error');
    }
    if (typeof message !== 'string' || message.length === 0 || message.length > LIMITS.toastChars) {
      return invalid(`message must be text of 1 to ${LIMITS.toastChars} characters`);
    }
    return { level, message };
  },
  'ui.openLink'(p: Record<string, unknown>): { url: URL } {
    onlyKeys(p, ['url']);
    const raw = p['url'];
    if (typeof raw !== 'string' || raw.length > LIMITS.linkChars) {
      return invalid(`url must be text of at most ${LIMITS.linkChars} characters`);
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return invalid('url must be an absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return invalid('url must be https: or http:');
    }
    if (url.username || url.password) {
      return invalid('url must not carry credentials');
    }
    return { url };
  },
  'storage.get'(p: Record<string, unknown>): { key: string } {
    onlyKeys(p, ['key']);
    return { key: storageKey(p['key']) };
  },
  'storage.set'(p: Record<string, unknown>): { key: string; value: unknown } {
    onlyKeys(p, ['key', 'value']);
    if (!('value' in p)) {
      return invalid('value is required (null deletes the key)');
    }
    return { key: storageKey(p['key']), value: p['value'] };
  },
  'storage.keys'(p: Record<string, unknown>): Record<string, never> {
    onlyKeys(p, []);
    return {};
  },
} as const;

function storageKey(v: unknown): string {
  if (typeof v !== 'string' || !STORAGE_KEY.test(v)) {
    return invalid('key must be 1 to 128 characters of A-Z a-z 0-9 . _ : -');
  }
  return v;
}

/** The token bucket of one instance: `messagesPerSecond`, burst `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}
