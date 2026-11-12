// Bundles a Drawboard plugin into the ZIP an instance admin installs (Plugins page, S3.9).
//
//   node scripts/plugin-bundle.mjs <plugin dir> [out dir]       (npm run plugin:sample)
//
// <plugin dir> holds drawboard-plugin.json and index.ts (the entry, importing the SDK from
// src/plugin-sdk). The entry is bundled with esbuild into one ES module named as the manifest's
// `entry`; the ZIP holds exactly the manifest and that module, with fixed timestamps so the same
// source gives the same bytes (and the same SHA-384 the admin page shows). The checks are the
// cheap ones of api docs/plugin-protocol.md; the server checks everything again on install.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { zipSync } from 'fflate';

const [dir, outDir = 'dist/plugins'] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/plugin-bundle.mjs <plugin dir> [out dir]');
  process.exit(2);
}

const fail = (message) => {
  console.error(`plugin-bundle: ${message}`);
  process.exit(1);
};

const manifestText = readFileSync(join(dir, 'drawboard-plugin.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const ID = /^(?!(core|drawboard)\.)[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
if (manifest.manifestVersion !== 1) fail('manifestVersion must be 1');
if (!ID.test(manifest.id ?? '') || manifest.id.length > 100) fail('id is not a valid plugin id');
if (!SEMVER.test(manifest.version ?? '')) fail('version is not Semantic Versioning');
if (!SEMVER.test(manifest.minHostVersion ?? '')) fail('minHostVersion is not Semantic Versioning');
if (!/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+\.m?js$/.test(manifest.entry ?? '')) {
  fail('entry must be a relative .js or .mjs path');
}
for (const type of manifest.blockTypes ?? []) {
  if (!type.type?.startsWith(`${manifest.id}.`))
    fail(`block type ${type.type} is outside ${manifest.id}`);
}

const result = await build({
  entryPoints: [join(dir, 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});
const code = result.outputFiles[0].contents;

// fixed date: reproducible bytes
const mtime = new Date('2026-01-01T00:00:00Z');
const zip = zipSync(
  {
    'drawboard-plugin.json': [new TextEncoder().encode(manifestText), { mtime }],
    [manifest.entry]: [code, { mtime }],
  },
  { level: 9 },
);
if (zip.length > 20 * 1_000_000) fail('the ZIP is larger than 20 MB');

mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, `${manifest.id}-${manifest.version}.zip`);
writeFileSync(file, zip);
const sha384 = createHash('sha384').update(zip).digest('hex');
const sha256 = createHash('sha256').update(zip).digest('hex');
console.log(`${file}
  size     ${zip.length} bytes (entry ${code.length} bytes)
  sha384   ${sha384}   <- compare with the Plugins page
  sha256   ${sha256}   <- part of the asset path`);
