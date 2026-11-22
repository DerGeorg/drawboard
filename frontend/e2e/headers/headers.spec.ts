import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// the same checker as `npm run check:headers`
import { GIPHY_ORIGIN, checkNginxTemplate, gifsState } from '../../scripts/check-headers.mjs';

/**
 * The security headers of the frontend's nginx (deploy/nginx/default.conf.template) against
 * architecture S7.5 and its refinements - checked on the template itself, so no container and
 * no browser is needed. The second test proves the checker notices when a header breaks.
 */
const TEMPLATE = readFileSync(join(__dirname, '../../deploy/nginx/default.conf.template'), 'utf8');

test.describe('nginx security headers (S7.5)', () => {
  test('when the template is checked then every header matches S7.5', () => {
    const { errors, notes } = checkNginxTemplate(TEMPLATE);

    expect(errors, 'no deviation from S7.5').toEqual([]);
    expect(notes, 'no open note').toEqual([]);
  });

  test('when GIFS_ENABLED is true then img-src names GIPHY and nothing else changes (G12)', () => {
    const on = gifsState(TEMPLATE, 'true');
    const off = gifsState(TEMPLATE, 'false');

    expect(on.imgSrc, 'img-src with GIFs').toContain(GIPHY_ORIGIN);
    expect(
      on.imgSrc.filter((s: string) => s.includes('giphy')),
      'exactly one GIPHY source',
    ).toEqual([GIPHY_ORIGIN]);
    expect(on.flag, '/config.json with GIFs').toBe('true');
    expect(off.csp, 'the CSP without GIFs never names GIPHY').not.toContain('giphy');
    expect(off.flag, '/config.json without GIFs').toBe('false');
    // every other directive is the same in both states
    const others = [...(on.directives as Map<string, string[]>)].filter(
      ([name]) => name !== 'img-src',
    );
    for (const [name, sources] of others) {
      expect(off.directives.get(name), name).toEqual(sources);
    }
    expect(
      TEMPLATE.match(/giphy/gi) ?? [],
      'GIPHY is named in comments and one map',
    ).not.toHaveLength(0);
  });

  test('when GIFS_ENABLED is anything but true then GIFs stay off (G3, fail closed)', () => {
    for (const value of [
      '',
      'false',
      'TRUE',
      'True',
      '1',
      'yes',
      'true ',
      ' true',
      'truee',
      '$x',
    ]) {
      const state = gifsState(TEMPLATE, value);
      expect(state.csp, `CSP for "${value}"`).not.toContain('giphy');
      expect(state.flag, `config for "${value}"`).toBe('false');
    }
  });

  test('when the GIF rules are weakened then the check fails with the reason', () => {
    const cases: [string, (t: string) => string, string][] = [
      [
        'any value switches GIFs on',
        (t) =>
          t.replace('"~^true$" "https://media.giphy.com";', 'default "https://media.giphy.com";'),
        'must not put GIPHY into the CSP',
      ],
      [
        'GIPHY in connect-src',
        (t) =>
          t.replace(
            "connect-src 'self' $oidc_origin",
            "connect-src 'self' https://media.giphy.com",
          ),
        'connect-src must not name GIPHY',
      ],
      [
        'a wildcard host for GIPHY',
        (t) => t.replace('"https://media.giphy.com";', '"https://*.giphy.com";'),
        'img-src may name exactly',
      ],
      [
        'the config flag is hard-wired',
        (t) => t.replace('"gifsEnabled":$gifs_enabled_json', '"gifsEnabled":true'),
        '/config.json must carry',
      ],
      [
        'the host is written into the CSP itself',
        (t) =>
          t.replace(
            "img-src 'self' blob: data: $files_origin $gifs_img_src",
            "img-src 'self' blob: data: $files_origin https://media.giphy.com",
          ),
        'must be written in the map $gifs_img_src and nowhere else',
      ],
    ];
    for (const [name, mutate, message] of cases) {
      const changed = mutate(TEMPLATE);
      expect(changed, `${name}: the mutation applies`).not.toBe(TEMPLATE);
      expect(checkNginxTemplate(changed).errors.join('\n'), name).toContain(message);
    }
  });

  test('when a header is weakened then the check fails with the reason', () => {
    const cases: [string, (t: string) => string, string][] = [
      [
        'eval allowed',
        (t) => t.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-eval'"),
        "script-src must never contain 'unsafe-eval'",
      ],
      [
        'inline scripts',
        (t) =>
          t.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline'"),
        "script-src must never contain 'unsafe-inline'",
      ],
      [
        'inline scripts through script-src-elem',
        (t) =>
          t.replace(
            "style-src 'self' 'unsafe-inline';",
            "script-src-elem 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
          ),
        "script-src-elem must never contain 'unsafe-inline'",
      ],
      [
        'data: documents as frames through child-src',
        (t) => t.replace("object-src 'none';", "child-src 'self' data:; object-src 'none';"),
        'child-src contains data:',
      ],
      [
        'an unknown directive',
        (t) => t.replace("object-src 'none';", "object-src 'none'; prefetch-src 'self';"),
        'prefetch-src is not a directive of S7.5',
      ],
      [
        'inline script on the silent-renew entry',
        (t) =>
          t.replace(
            `/silent-renew.html "default-src 'none'; script-src 'self';`,
            `/silent-renew.html "default-src 'none'; script-src 'self' 'unsafe-inline';`,
          ),
        "CSP of /silent-renew.html: script-src must never contain 'unsafe-inline'",
      ],
      [
        'bare wss:',
        (t) => t.replace("connect-src 'self' $oidc_origin", "connect-src 'self' wss: $oidc_origin"),
        'connect-src must never contain wss:',
      ],
      [
        'framable',
        (t) => t.replace("frame-ancestors 'none'; require", "frame-ancestors 'self'; require"),
        "frame-ancestors contains 'self'",
      ],
      [
        'form-action to the provider',
        (t) => t.replace("form-action 'self';", "form-action 'self' $oidc_origin;"),
        'form-action contains $oidc_origin',
      ],
      [
        'trusted types off',
        (t) => t.replace("require-trusted-types-for 'script'; ", ''),
        "require-trusted-types-for 'script' is missing",
      ],
      [
        'trusted types policy names open',
        (t) =>
          t.replace(
            'trusted-types angular dompurify drawboard default',
            "trusted-types * 'allow-duplicates'",
          ),
        "trusted-types must never contain 'allow-duplicates'",
      ],
      [
        'angular bypass policy',
        (t) =>
          t.replace(
            'dompurify drawboard default',
            'dompurify drawboard default angular#unsafe-bypass',
          ),
        'trusted-types must never contain angular#unsafe-bypass',
      ],
      ['no object-src', (t) => t.replace("object-src 'none'; ", ''), 'object-src is missing'],
      [
        'referrer leaks',
        (t) => t.replace('"no-referrer" always', '"strict-origin" always'),
        'Referrer-Policy is "strict-origin"',
      ],
      [
        'nosniff gone',
        (t) => t.replace(/^\s*add_header X-Content-Type-Options\s+"nosniff" always;\n/m, ''),
        'X-Content-Type-Options is missing',
      ],
      [
        'not always',
        (t) => t.replace('"same-origin" always', '"same-origin"'),
        'Cross-Origin-Opener-Policy is not sent with "always"',
      ],
      [
        'short HSTS',
        (t) => t.replace('max-age=31536000; includeSubDomains', 'max-age=3600'),
        'Strict-Transport-Security is',
      ],
      [
        'framing allowed by default',
        (t) => t.replace(/default\s+DENY;/, 'default              SAMEORIGIN;'),
        'X-Frame-Options: the default must be DENY',
      ],
      [
        'cached shell',
        (t) =>
          t.replace(
            '/index.html                                "no-store";',
            '/index.html "no-cache";',
          ),
        'Cache-Control of /index.html must be no-store',
      ],
      [
        'query in the files log',
        (t) => t.replace('"$request_method $uri $server_protocol"', '"$request"'),
        'files_no_query must not contain the query string',
      ],
      [
        'the card id in the estimation log',
        (t) =>
          t.replace(
            '"$request_method $estimation_log_uri $server_protocol"',
            '"$request_method $uri $server_protocol"',
          ),
        'log_format estimation_no_item must log $estimation_log_uri',
      ],
      [
        'estimation routes logged in full',
        (t) => t.replace(/^\s*access_log \S+ main if=\$estimation_log_full;\n/m, ''),
        'must log estimation placements and estimates with estimation_no_item only',
      ],
      [
        'the card segment not masked',
        (t) => t.replace('"$estimation_head/-/$estimation_op"', '$uri'),
        'map $estimation_log_uri must mask the card',
      ],
      [
        'a location drops the headers',
        (t) =>
          t.replace('location = /healthz {', 'location = /healthz {\n    add_header X-Test 1;'),
        'location = /healthz has its own add_header',
      ],
      [
        'dotted paths fall back to the SPA shell',
        (t) => t.replace(/ {2}location ~ \/\[\^\/\]\*\\\.\[\^\/\]\*\$ \{[^}]*\}\n\n/, ''),
        'try_files $uri =404; } is missing',
      ],
      [
        'the files proxy loses its priority',
        (t) => t.replace('location ^~ /files/ {', 'location /files/ {'),
        'location /files/ must be "^~ /files/"',
      ],
      [
        'the pdf.js worker as octet-stream',
        (t) => t.replace('text/javascript mjs;', 'text/plain txt;'),
        '.mjs must be served as text/javascript',
      ],
      [
        'the mime table replaced',
        (t) => t.replace('include mime.types;', ''),
        'needs include mime.types',
      ],
      [
        'the app host serves plugin files again (S3.4)',
        (t) => t.replace(/^\s*"~\^app\/plugin-assets\(\/\|\$\)"\s+1;\n/m, ''),
        'the app host must refuse /plugin-assets/p/1/a.js',
      ],
      [
        'the plugin host serves the app too (S3.4)',
        (t) => t.replace(/^\s*"~\^plugin\/"\s+1;\n/m, ''),
        'the plugin host must refuse /config.json',
      ],
      [
        'the plugin host loses its files (S3.4)',
        (t) => t.replace(/^\s*"~\^plugin\/plugin-assets\/"\s+0;\n/m, ''),
        'the plugin host must serve /plugin-assets/p/1/a.js',
      ],
      [
        'the refusal is gone (S3.4)',
        (t) => t.replace(/^\s*if \(\$deny_request\) \{\n\s*return 404;\n\s*\}\n/m, ''),
        '`if ($deny_request) { return 404; }` is missing',
      ],
      [
        'the refusal comes after the locations (S3.4)',
        (t) =>
          t
            .replace(/^\s*if \(\$deny_request\) \{\n\s*return 404;\n\s*\}\n/m, '')
            .replace(
              '  location = /healthz {',
              '  if ($deny_request) { return 404; }\n  location = /healthz {',
            ),
        'the $deny_request check must come before the first location',
      ],
      [
        'the refused answer takes the plugin exemption',
        (t) =>
          t.replace(
            'map $header_uri $content_security_policy',
            'map $uri $content_security_policy',
          ),
        'map $content_security_policy must look at $header_uri',
      ],
      [
        'the refused answer is exempt from X-Frame-Options',
        (t) => t.replace('1       "/denied";', '1       "/plugin-assets/denied";'),
        'the 404 of a refused request carries no Content-Security-Policy',
      ],
      [
        'the host is compared case-sensitive',
        (t) => t.replace('"~*^ok:(?<host_in_header>', '"~^ok:(?<host_in_header>'),
        'is "app", expected plugin',
      ],
      [
        'any origin is an authority',
        (t) => t.replace('(:[0-9]{1,5})?)$" $authority;', '.*)$" $authority;'),
        'must give no authority',
      ],
      [
        'without a plugin origin the hosts are split anyway',
        (t) => t.replace(/^\s*"~\^unset:"\s+legacy;\n/m, ''),
        'is "app", expected legacy',
      ],
      [
        'an invalid plugin origin is not recognised',
        (t) => t.replace(/^\s*"~\^invalid:"\s+invalid;\n/m, ''),
        'is "app", expected invalid',
      ],
      [
        'an invalid plugin origin serves anything (fails open)',
        (t) => t.replace(/^\s*"~\^invalid\/"\s+1;\n/m, ''),
        'must be refused (fail closed)',
      ],
      [
        'any character may pose as the plugin host',
        (t) => t.replace('(?<host_in_header>[A-Za-z0-9.:-]+)', '(?<host_in_header>.+)'),
        'is "plugin", expected app',
      ],
      ['server tokens', (t) => t.replace('server_tokens off;', ''), 'server_tokens off is missing'],
    ];
    for (const [name, mutate, message] of cases) {
      const changed = mutate(TEMPLATE);
      expect(changed, `${name}: the mutation applies`).not.toBe(TEMPLATE);
      expect(checkNginxTemplate(changed).errors.join('\n'), name).toContain(message);
    }
  });
});
