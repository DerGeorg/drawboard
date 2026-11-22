import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE = readFileSync(join(__dirname, '../../deploy/nginx/default.conf.template'), 'utf8');

/**
 * The CSP nginx sends for the app (the `default` entry of `map <var> $content_security_policy`;
 * the input variable is `$header_uri` since the plugin origin split, it was `$uri` before),
 * read from the template itself so the e2e specs can never drift from production. The origins
 * the deployment may add (files, plugin, OIDC) are empty and `upgrade-insecure-requests` is
 * left out (the specs run over http or on made-up https origins).
 */
export function appCsp(origins: { oidc?: string; gifs?: boolean } = {}): string {
  // Found by the output variable, not the input: a renamed input ($uri -> $header_uri) must not
  // silently point the search at the end of the file.
  const start = /^map\s+\S+\s+\$content_security_policy\s*\{/m.exec(TEMPLATE)?.index;
  if (start === undefined) {
    throw new Error('no map ... $content_security_policy in the nginx template');
  }
  const map = TEMPLATE.slice(start, TEMPLATE.indexOf('\n}', start));
  const value = /^\s*default\s+"([^"]+)";/m.exec(map)?.[1];
  if (!value) {
    throw new Error('no default CSP in the nginx template');
  }
  return (
    value
      .replace('$csp_upgrade', '')
      .replaceAll('$oidc_origin', origins.oidc ?? '')
      .replaceAll('$files_origin', '')
      .replaceAll('$plugin_origin', '')
      // GIFS_ENABLED=true adds exactly one host (Fable G12); off by default
      .replaceAll('$gifs_img_src', origins.gifs ? 'https://media.giphy.com' : '')
      .replace(/\s+;/g, ';')
  );
}

/**
 * Installs a recorder for `securitypolicyviolation` events of the top frame (frames of hostile
 * plugins are expected to hit their own CSP). Call before `page.goto`; read with `violations`.
 */
export const RECORD_VIOLATIONS = `
  window.__violations = [];
  if (window === window.top) {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__violations.push({
        violatedDirective: e.violatedDirective,
        effectiveDirective: e.effectiveDirective,
        disposition: e.disposition,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        sample: e.sample,
      });
    });
  }
`;
