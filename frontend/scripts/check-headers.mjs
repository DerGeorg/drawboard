#!/usr/bin/env node
// Checks the security headers of the frontend's nginx template (deploy/nginx/default.conf.template)
// against architecture.md S7.5 and the refinements of the reviews (M1: no bare wss:; M3: /files/
// and /plugin-assets/ carry the backend's headers only; S1.2: Referrer-Policy no-referrer; S7.2:
// no query string in the /files/ access log; S3.4: the plugin host serves /plugin-assets/ only, the
// app host never, told apart by Host). No dependencies: it reads the template as text.
//
//   npm run check:headers [-- template]     exit code 1 on an error; notes are printed
//
// Used by e2e/headers/headers.spec.ts (Playwright project `sandbox`), so the pipeline runs it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Origins the template fills in at container start; each stands for one validated origin. */
const FILES = '$files_origin';
const OIDC = '$oidc_origin';
const PLUGIN = '$plugin_origin';

/**
 * S7.5 per CSP directive: the sources that are allowed (anything else is an error), the ones
 * that must be there, and the ones that are allowed but deviate from the letter of S7.5 (a note).
 */
const CSP_RULES = {
  'default-src': { allowed: ["'self'"], required: ["'self'"] },
  'script-src': { allowed: ["'self'", "'wasm-unsafe-eval'"], required: ["'self'"] },
  // not in the template today; if one is added it must not widen script-src (M4 review SHOULD 2)
  'script-src-elem': { allowed: ["'self'"], required: [], optional: true },
  'script-src-attr': { allowed: ["'none'"], required: [], optional: true },
  'child-src': { allowed: ["'self'", OIDC, PLUGIN], required: [], optional: true },
  'style-src': { allowed: ["'self'", "'unsafe-inline'"], required: ["'self'"] },
  'img-src': { allowed: ["'self'", 'blob:', 'data:', FILES], required: ["'self'"] },
  'media-src': { allowed: ["'self'", 'blob:', FILES], required: ["'self'"] },
  'font-src': { allowed: ["'self'"], required: ["'self'"] },
  'connect-src': { allowed: ["'self'", OIDC, FILES], required: ["'self'"] },
  'worker-src': { allowed: ["'self'", 'blob:'], required: ["'self'"] },
  // S7.5: <plugin-origin> <embed-allowlist>; 'self' carries the same-origin plugin frames
  // (/plugin-assets/, M3 review S3.4) and the silent sign-in page, the provider its
  // authorization endpoint - decided in the M4 review, so no note (the embed allowlist is
  // empty = off, S5.4)
  'frame-src': { allowed: ["'self'", OIDC, PLUGIN], required: [] },
  'object-src': { allowed: ["'none'"], required: ["'none'"] },
  'base-uri': { allowed: ["'self'"], required: ["'self'"] },
  // S7.5: no form is posted to the provider (M4 review SHOULD 4)
  'form-action': { allowed: ["'self'"], required: ["'self'"] },
  'frame-ancestors': { allowed: ["'none'"], required: ["'none'"] },
};

const REQUIRED_DIRECTIVES = Object.entries(CSP_RULES)
  .filter(([, rule]) => !rule.optional)
  .map(([name]) => name);

/** Sources that must never appear in any directive of the app's CSP. */
const NEVER = ["'unsafe-eval'", '*', 'http:', 'https:', 'ws:', 'wss:'];

/**
 * Directives that decide what script (or plugins, or the base of relative URLs) may run: no
 * inline code, hashed event handlers, data: or blob: documents there.
 */
const SCRIPT_DIRECTIVES = [
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'object-src',
  'base-uri',
];
const NEVER_IN_SCRIPT_DIRECTIVES = ["'unsafe-inline'", "'unsafe-hashes'", 'data:', 'blob:'];

/** The location that keeps dotted paths away from the SPA fallback. */
const DOTTED_LOCATION = '~ /[^/]*\\.[^/]*$';

/** What S3.12 decided for Trusted Types (architecture.md, M4 frontend review). */
const TRUSTED_TYPES_POLICIES = ['angular', 'dompurify', 'drawboard', 'default'];

const PERMISSIONS = ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()'];

/** The line without its `# comment` (a `#` inside a quoted value, as in angular#unsafe-bypass, stays). */
function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === '#' && !quoted) return line.slice(0, i);
  }
  return line;
}

/** The lines of a `map <var> $name { ... }` block as [key, value] pairs. */
function mapEntries(text, name) {
  const start = text.search(new RegExp(`^map\\s+\\S+\\s+\\$${name}\\s*\\{`, 'm'));
  if (start < 0) {
    return undefined;
  }
  const body = text.slice(text.indexOf('{', start) + 1, text.indexOf('\n}', start));
  const entries = [];
  for (const raw of body.split('\n')) {
    const line = stripComment(raw).trim();
    const m = /^("[^"]*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+);$/.exec(line);
    if (m) {
      entries.push([m[1].replace(/^"|"$/g, ''), m[2].replace(/^"|"$/g, '')]);
    }
  }
  return entries;
}

function mapValue(text, name, key) {
  return mapEntries(text, name)?.find(([k]) => k === key)?.[1];
}

/** `add_header Name value always;` lines directly in the server block (not in a location). */
function serverHeaders(text) {
  const headers = new Map();
  let depth = 0;
  let inServer = false;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (/^\s*server\s*\{/.test(line)) {
      inServer = true;
      depth = 0;
    }
    if (inServer && depth === 1) {
      const m = /^\s*add_header\s+(\S+)\s+("(?:[^"\\]|\\.)*"|\S+)(\s+always)?\s*;/.exec(line);
      if (m) {
        headers.set(m[1].toLowerCase(), {
          value: m[2].replace(/^"|"$/g, ''),
          always: !!m[3],
        });
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
  }
  return headers;
}

/** Every `location ... { }` block (outermost text of each) with its add_header lines. */
function locationsWithHeaders(text) {
  const out = [];
  const re = /^\s*location\s+([^{]+)\{/gm;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
    }
    const body = text.slice(re.lastIndex, i);
    const own = body
      .split('\n')
      .map((l) => stripComment(l))
      .filter((l) => /^\s*add_header\s/.test(l));
    const full = m[1].trim();
    const prefix = /^\^~\s+/.test(full);
    out.push({
      name: full.replace(/^\^~\s+/, ''),
      priority: prefix,
      index: m.index,
      body,
      headers: own,
    });
  }
  return out;
}

function parseCsp(value) {
  const directives = new Map();
  for (const part of value.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) {
      directives.set(tokens[0], tokens.slice(1));
    }
  }
  return directives;
}

/** Sources that never belong into the directive, whatever its rule says. */
function isNever(name, source) {
  return (
    NEVER.includes(source) ||
    (SCRIPT_DIRECTIVES.includes(name) && NEVER_IN_SCRIPT_DIRECTIVES.includes(source))
  );
}

function checkNever(label, name, sources, errors) {
  for (const s of sources.filter((source) => isNever(name, source))) {
    errors.push(`${label}: ${name} must never contain ${s}`);
  }
}

/** The CSP of the app (map entry `default`, or any other entry that is not a special case). */
function checkAppCsp(label, csp, text, errors, notes, isDefault) {
  const upgrade = csp.includes('$csp_upgrade');
  const directives = parseCsp(csp.replace('$csp_upgrade', ''));
  for (const name of REQUIRED_DIRECTIVES) {
    if (!directives.has(name)) {
      errors.push(`${label}: ${name} is missing`);
    }
  }
  for (const [name, sources] of directives) {
    const rule = CSP_RULES[name];
    if (!rule) {
      if (name === 'require-trusted-types-for' || name === 'trusted-types') {
        checkTrustedTypes(label, name, sources, errors);
      } else {
        errors.push(`${label}: ${name} is not a directive of S7.5`);
      }
      checkNever(label, name, sources, errors);
      continue;
    }
    for (const s of sources) {
      if (isNever(name, s)) {
        errors.push(`${label}: ${name} must never contain ${s}`);
      } else if (!rule.allowed.includes(s)) {
        errors.push(`${label}: ${name} contains ${s}, S7.5 allows ${rule.allowed.join(' ')}`);
      } else if (rule.notes?.[s]) {
        notes.push(`${label}: ${rule.notes[s]}`);
      }
    }
    for (const s of rule.required) {
      if (!sources.includes(s)) {
        errors.push(`${label}: ${name} must contain ${s}`);
      }
    }
  }
  if (!upgrade) {
    errors.push(`${label}: upgrade-insecure-requests ($csp_upgrade) is missing`);
  } else if (isDefault) {
    const map = mapEntries(text, 'csp_upgrade') ?? [];
    for (const env of ['dev', 'prod']) {
      if (!map.some(([k, v]) => k === env && v.includes('upgrade-insecure-requests'))) {
        errors.push(`${label}: upgrade-insecure-requests is not on for ${env}`);
      }
    }
  }
  if (isDefault) {
    if (!directives.has('require-trusted-types-for')) {
      errors.push(`${label}: require-trusted-types-for 'script' is missing (S3.12)`);
    }
    const names = directives.get('trusted-types');
    if (!names) {
      errors.push(`${label}: trusted-types ${TRUSTED_TYPES_POLICIES.join(' ')} is missing (S3.12)`);
    } else {
      for (const policy of TRUSTED_TYPES_POLICIES.filter((p) => !names.includes(p))) {
        errors.push(`${label}: trusted-types must contain ${policy} (S3.12)`);
      }
    }
  }
}

/** S3.12: `require-trusted-types-for 'script'; trusted-types angular dompurify drawboard default`. */
function checkTrustedTypes(label, name, sources, errors) {
  if (name === 'require-trusted-types-for') {
    if (sources.length !== 1 || sources[0] !== "'script'") {
      errors.push(`${label}: require-trusted-types-for must be 'script'`);
    }
    return;
  }
  for (const s of sources) {
    if (s === "'allow-duplicates'" || s.includes('unsafe-bypass')) {
      errors.push(`${label}: trusted-types must never contain ${s}`);
    } else if (!TRUSTED_TYPES_POLICIES.includes(s)) {
      errors.push(
        `${label}: trusted-types contains ${s}, S3.12 allows ${TRUSTED_TYPES_POLICIES.join(' ')}`,
      );
    }
  }
}

/** `/silent-renew.html`: nothing but its own script, framed by the app only. */
function checkSilentRenewCsp(csp, errors) {
  const label = 'CSP of /silent-renew.html';
  const allowed = {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'frame-ancestors': ["'self'"],
  };
  const directives = parseCsp(csp);
  for (const name of Object.keys(allowed)) {
    if (!directives.has(name)) {
      errors.push(`${label}: ${name} is missing`);
    }
  }
  for (const [name, sources] of directives) {
    checkNever(label, name, sources, errors);
    if (!(name in allowed)) {
      errors.push(`${label}: ${name} is not expected here`);
    } else if (sources.some((s) => !allowed[name].includes(s))) {
      errors.push(`${label}: ${name} must be ${allowed[name].join(' ')}`);
    }
  }
}

/**
 * Evaluates a `map` block the way nginx does for a string key: exact keys first, then the
 * regular expressions (`~` case-sensitive, `~*` not) in the order of the file, then `default`.
 * Named captures can be used as `$name` in the value. Returns undefined when the map is missing.
 */
function evalMap(text, name, key, variables = {}) {
  const entries = mapEntries(text, name);
  if (!entries) {
    return undefined;
  }
  const substitute = (value, groups = {}) =>
    value.replace(/\$(\w+)/g, (all, v) => groups[v] ?? variables[v] ?? all);
  const exact = entries.find(([k]) => k === key);
  if (exact) {
    return substitute(exact[1]);
  }
  for (const [k, value] of entries) {
    const m = /^~(\*?)(.*)$/s.exec(k);
    if (m) {
      const match = new RegExp(m[2], m[1] ? 'i' : '').exec(key);
      if (match) {
        return substitute(value, match.groups);
      }
    }
  }
  return entries.find(([k]) => k === 'default') ? substitute(mapValue(text, name, 'default')) : '';
}

/**
 * S3.4: the plugin origin is the same container as the app, told apart by Host. The plugin host
 * serves /plugin-assets/ and nothing else, the app host never serves /plugin-assets/ (a plugin
 * file on the app origin is a 'self' script gadget); without a plugin origin nothing changes.
 * The maps are evaluated here for a matrix of origins, hosts and paths.
 */
function checkPluginOriginSplit(text, errors) {
  const authorityOf = (origin) => evalMap(text, 'plugin_authority', origin);
  const stateOf = (origin) => evalMap(text, 'plugin_origin_state', origin);
  const roleOf = (host, origin) =>
    evalMap(text, 'host_role', `${stateOf(origin)}:${host}|${authorityOf(origin)}`);
  const denies = (role, uri) => evalMap(text, 'deny_request', `${role}${uri}`) === '1';

  const missing = [
    'plugin_origin_state',
    'plugin_authority',
    'host_role',
    'deny_request',
    'header_uri',
  ].filter((name) => !mapEntries(text, name));
  for (const name of missing) {
    errors.push(`plugin origin: map $${name} is missing (S3.4)`);
  }
  if (missing.length > 0) {
    return;
  }

  // the server refuses before a location is chosen, with the server's headers
  const server = text.slice(text.search(/^server\s*\{/m));
  const guard = /^\s*if\s*\(\$deny_request\)\s*\{\s*return\s+404\s*;\s*\}/m.exec(server);
  if (!guard) {
    errors.push(
      'plugin origin: `if ($deny_request) { return 404; }` is missing in the server block',
    );
  } else if (guard.index > server.search(/^\s*location\s/m)) {
    errors.push('plugin origin: the $deny_request check must come before the first location');
  }
  for (const name of ['content_security_policy', 'frame_options', 'cache_control']) {
    if (!new RegExp(`^map\\s+\\$header_uri\\s+\\$${name}\\s*\\{`, 'm').test(text)) {
      errors.push(
        `plugin origin: map $${name} must look at $header_uri, or the 404 of a refused request loses the app's headers`,
      );
    }
  }

  const PLUGIN = 'https://drawboard-plugins.example.org';
  const PLUGIN_HOST = 'drawboard-plugins.example.org';
  const APP = 'draw.example.org';
  const authority = authorityOf(PLUGIN);
  if (authority !== PLUGIN_HOST) {
    errors.push(
      `plugin origin: the authority of ${PLUGIN} is "${authority}", expected ${PLUGIN_HOST}`,
    );
  }
  if (authorityOf('https://h.example.org:8443') !== 'h.example.org:8443') {
    errors.push('plugin origin: a port is part of the authority');
  }
  for (const bad of ['', 'https://h/x', 'javascript:alert(1)', 'https://h; script-src *']) {
    if (authorityOf(bad) !== '') {
      errors.push(`plugin origin: "${bad}" must give no authority`);
    }
  }

  const roles = [
    [PLUGIN_HOST, PLUGIN, 'plugin'],
    ['Drawboard-Plugins.Example.ORG', PLUGIN, 'plugin'],
    [APP, PLUGIN, 'app'],
    [`${PLUGIN_HOST}:8443`, PLUGIN, 'app'],
    [`evil-${PLUGIN_HOST}`, PLUGIN, 'app'],
    [`${PLUGIN_HOST}.evil.org`, PLUGIN, 'app'],
    ['', PLUGIN, 'app'],
    [APP, '', 'legacy'],
    [PLUGIN_HOST, '', 'legacy'],
    ['', '', 'legacy'],
    // a Host with the map separator can never pose as the plugin host
    [`x|${PLUGIN_HOST}|x`, PLUGIN, 'app'],
    // set but invalid: fail closed, never legacy
    [APP, 'https://h/x', 'invalid'],
    [PLUGIN_HOST, 'javascript:alert(1)', 'invalid'],
  ];
  for (const [host, origin, expected] of roles) {
    const role = roleOf(host, origin);
    if (role !== expected) {
      errors.push(
        `plugin origin: Host "${host}" with PLUGIN_ORIGIN "${origin}" is "${role}", expected ${expected}`,
      );
    }
  }

  const assets = ['/plugin-assets/p/1/a.js', '/plugin-assets/p/1/__drawboard/frame.html'];
  const others = [
    '/',
    '/index.html',
    '/config.json',
    '/healthz',
    '/api/boards',
    '/files/x',
    '/faro/collect',
    '/silent-renew.html',
    '/x/plugin-assets/y',
  ];
  for (const uri of assets) {
    if (denies('plugin', uri)) errors.push(`plugin origin: the plugin host must serve ${uri}`);
    if (!denies('app', uri)) errors.push(`plugin origin: the app host must refuse ${uri} (404)`);
    if (denies('legacy', uri))
      errors.push(`plugin origin: without a plugin origin ${uri} is served`);
  }
  for (const uri of [...others, '/plugin-assets']) {
    if (!denies('plugin', uri))
      errors.push(`plugin origin: the plugin host must refuse ${uri} (404)`);
    if (denies('legacy', uri))
      errors.push(`plugin origin: without a plugin origin ${uri} is served`);
  }
  for (const uri of others) {
    if (denies('app', uri)) errors.push(`plugin origin: the app host must serve ${uri}`);
  }
  for (const uri of [...assets, ...others, '/healthz']) {
    if (!denies('invalid', uri))
      errors.push(
        `plugin origin: with an invalid PLUGIN_ORIGIN ${uri} must be refused (fail closed)`,
      );
  }
  if (!denies('app', '/plugin-assets')) {
    errors.push(
      'plugin origin: the app host must refuse /plugin-assets, too (no 301 into the exemption)',
    );
  }

  // the 404 of a refused request is judged like an app page: the CSP, X-Frame-Options and
  // Cache-Control exemptions of /files/ and /plugin-assets/ must not apply to it
  const denied = evalMap(text, 'header_uri', '1', { uri: '/plugin-assets/x' });
  const answered = evalMap(text, 'header_uri', '0', { uri: '/plugin-assets/x' });
  if (answered !== '/plugin-assets/x') {
    errors.push('plugin origin: $header_uri must be $uri for an answered request');
  }
  if (!evalMap(text, 'content_security_policy', denied)) {
    errors.push('plugin origin: the 404 of a refused request carries no Content-Security-Policy');
  }
  if (evalMap(text, 'frame_options', denied) !== 'DENY') {
    errors.push('plugin origin: the 404 of a refused request must carry X-Frame-Options DENY');
  }
}

/**
 * Checks the template text. Returns `{ errors, notes }`: an error breaks S7.5 (or a refinement),
 * a note is a deliberate deviation or an open SHOULD worth seeing.
 */
export function checkNginxTemplate(text) {
  const errors = [];
  const notes = [];

  // --- Content-Security-Policy ---------------------------------------------------------------
  const entries = mapEntries(text, 'content_security_policy') ?? [];
  const csp = mapValue(text, 'content_security_policy', 'default');
  if (!csp) {
    errors.push('no default Content-Security-Policy in map $content_security_policy');
  } else {
    checkAppCsp('CSP', csp, text, errors, notes, true);
  }
  // every other entry of the map is checked as well; two have a rule of their own
  for (const [key, value] of entries) {
    if (key === 'default') {
      continue;
    }
    if (key.includes('files|plugin-assets')) {
      if (value !== '') {
        errors.push(
          'CSP: /files/ and /plugin-assets/ must get no CSP from nginx (the backend sends its own)',
        );
      }
    } else if (key === '/silent-renew.html') {
      checkSilentRenewCsp(value, errors);
    } else {
      checkAppCsp(`CSP of ${key}`, value, text, errors, notes, false);
    }
  }

  // --- the other headers (server level, with "always") ----------------------------------------
  const headers = serverHeaders(text);
  const expect = (name, check, what) => {
    const h = headers.get(name.toLowerCase());
    if (!h) {
      errors.push(`${name} is missing`);
    } else if (!check(h.value)) {
      errors.push(`${name} is "${h.value}", expected ${what}`);
    } else if (!h.always) {
      errors.push(`${name} is not sent with "always" (error answers would lack it)`);
    }
  };
  expect('Content-Security-Policy', (v) => v === '$content_security_policy', 'the CSP map');
  expect('X-Content-Type-Options', (v) => v === 'nosniff', 'nosniff');
  expect('Referrer-Policy', (v) => v === 'no-referrer', 'no-referrer');
  expect('X-Frame-Options', (v) => v === '$frame_options', 'the frame options map');
  if (mapValue(text, 'frame_options', 'default') !== 'DENY') {
    errors.push('X-Frame-Options: the default must be DENY');
  }
  expect(
    'Permissions-Policy',
    (v) => PERMISSIONS.every((p) => v.split(/,\s*/).includes(p)),
    PERMISSIONS.join(', '),
  );
  expect('Cross-Origin-Opener-Policy', (v) => v === 'same-origin', 'same-origin');
  expect(
    'Strict-Transport-Security',
    (v) => Number(/max-age=(\d+)/.exec(v)?.[1] ?? 0) >= 31536000 && v.includes('includeSubDomains'),
    'max-age=31536000; includeSubDomains',
  );
  expect('Cache-Control', (v) => v === '$cache_control', 'the cache control map');
  for (const file of ['/index.html', '/config.json']) {
    if (mapValue(text, 'cache_control', file) !== 'no-store') {
      errors.push(`Cache-Control of ${file} must be no-store`);
    }
  }
  if (headers.has('access-control-allow-origin')) {
    errors.push('Access-Control-Allow-Origin must not be added (no CORS, S7.4)');
  }
  if (!/^\s*server_tokens\s+off\s*;/m.test(text)) {
    errors.push('server_tokens off is missing');
  }

  // --- locations ----------------------------------------------------------------------------
  for (const loc of locationsWithHeaders(text)) {
    if (
      loc.headers.length > 0 &&
      !loc.headers.some((l) => /X-Content-Type-Options\s+"?nosniff/.test(l))
    ) {
      errors.push(
        `location ${loc.name} has its own add_header and drops the server's headers: nosniff must be repeated`,
      );
    }
  }
  const api = locationsWithHeaders(text).find((l) => l.name === '/api/');
  if (!api || !/proxy_hide_header\s+Access-Control-Allow-Origin/.test(api.body)) {
    errors.push('/api/ must hide Access-Control-Allow-Origin of the upstream');
  }
  const files = locationsWithHeaders(text).find((l) => l.name === '/files/');
  if (!files || !/access_log\s+\S+\s+files_no_query/.test(files.body)) {
    errors.push('/files/ must log without the query string (S7.2)');
  }
  const format = /log_format\s+files_no_query([^;]+);/.exec(text)?.[1] ?? '';
  if (/\$request_uri|\$request\b|\$args|\$query_string|\$http_referer/.test(format)) {
    errors.push('log_format files_no_query must not contain the query string or the referrer');
  }
  // the pdf.js worker is a module worker: .mjs must be JavaScript, and `types` replaces the table
  if (!/^\s*types\s*\{[^}]*(?:text|application)\/javascript\s+mjs\s*;/m.test(text)) {
    errors.push('.mjs must be served as text/javascript (types { text/javascript mjs; })');
  } else if (!/^\s*include\s+mime\.types\s*;/m.test(text)) {
    errors.push(
      'a types block at server level needs include mime.types, or every other type is lost',
    );
  }

  checkPluginOriginSplit(text, errors);

  // dotted paths (/.env) are files or 404, never the SPA shell (M4 review SHOULD 6)
  const locations = locationsWithHeaders(text);
  const spa = locations.find((l) => l.name === '/');
  const dotted = locations.find((l) => l.name === DOTTED_LOCATION);
  if (spa && /try_files[^;]*\/index\.html/.test(spa.body)) {
    if (!dotted) {
      errors.push(
        `location ${DOTTED_LOCATION} { try_files $uri =404; } is missing: /.env and friends get the SPA shell`,
      );
    } else {
      if (!/^\s*try_files\s+\$uri\s+=404\s*;/m.test(dotted.body)) {
        errors.push(`location ${DOTTED_LOCATION} must be try_files $uri =404`);
      }
      if (dotted.headers.length > 0) {
        errors.push(
          `location ${DOTTED_LOCATION} has its own add_header and drops the server's headers`,
        );
      }
      if (dotted.index > spa.index) {
        errors.push(`location ${DOTTED_LOCATION} must come before location /`);
      }
      // a regex location beats a plain prefix one: /files/x.pdf would never reach the backend
      for (const prefix of ['/api/', '/files/', '/plugin-assets/', '/faro/']) {
        const loc = locations.find((l) => l.name === prefix);
        if (loc && !loc.priority) {
          errors.push(
            `location ${prefix} must be "^~ ${prefix}": otherwise ${DOTTED_LOCATION} takes its dotted paths`,
          );
        }
      }
    }
  }

  return { errors, notes };
}

// no import.meta: Playwright loads this module from a TypeScript spec as well
if (process.argv[1]?.endsWith('check-headers.mjs')) {
  // npm runs scripts in the package root
  const file = process.argv[2] ?? join(process.cwd(), 'deploy/nginx/default.conf.template');
  const { errors, notes } = checkNginxTemplate(readFileSync(file, 'utf8'));
  for (const n of notes) console.log(`note:  ${n}`);
  for (const e of errors) console.log(`ERROR: ${e}`);
  console.log(errors.length === 0 ? 'Security headers match S7.5.' : `${errors.length} error(s).`);
  process.exit(errors.length === 0 ? 0 : 1);
}
