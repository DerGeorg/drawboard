#!/usr/bin/env node
// Checks that code generation produced every model exactly once, with exactly
// the name it has under components.schemas in common/common.yaml — and
// nothing else.
//
// openapi-generator invents names for every schema that is not a named
// component: CreateTaskRequest, ListTasks200Response, InlineObject1,
// TaskStatusEnum, Task1 (a second copy of Task) ... Such names are unreadable
// and change whenever an operation is renamed. The lint rules in redocly.yaml
// catch the usual causes; this script is the backstop that looks at what was
// actually generated.
//
// Aliases (`type: array`, or a primitive type without `enum`) and the
// schemas of multipart/form-data bodies are declared but deliberately not
// generated — see "Aliases" and "multipart" below.
//
// Usage (scripts/build.sh runs it after generation, before kotlinc):
//   node scripts/check-generated-models.mjs \
//     --schemas common/common.yaml \
//     --bundle build/openapi/openapi.yaml \
//     --kotlin build/generated/openapi/src/main/kotlin/<package path>/model \
//     --typescript build/generated/typescript-angular/model
//
// Exit code 0 = ok, 1 = findings (all of them are listed), 2 = usage error.
// Plain Node, no dependencies: the YAML files are read line by line, which is
// enough for the fixed layout of this repository (the keys under
// `components:` -> `schemas:`, indented by four spaces, are the schemas).

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
for (const required of ['schemas', 'bundle']) {
  if (!args[required]) {
    console.error(`usage: check-generated-models.mjs --schemas common/common.yaml --bundle <file> [--kotlin <dir>] [--typescript <dir>]`);
    process.exit(2);
  }
}

const problems = [];
const problem = (text) => problems.push(text);

// Names that compile but shadow language types in the generated files.
const RESERVED = new Set([
  'Any', 'Array', 'Boolean', 'Byte', 'Char', 'Date', 'Double', 'Error', 'Float', 'Int', 'List',
  'Long', 'Map', 'Nothing', 'Number', 'Object', 'Pair', 'Promise', 'Record', 'Set', 'Short',
  'String', 'Unit',
]);
// What openapi-generator produces for schemas without a component name.
const SYNTHETIC = [
  [/^InlineObject\d*$/, 'inline object'],
  [/^Inline\w*$/, 'inline schema'],
  [/\d{3}Response\w*$/, 'inline response body (<operation><status>Response)'],
  [/Request(Body)?$/, 'inline request body (<operation>Request)'],
  [/Inner$/, 'inline array item (...Inner)'],
  [/\d+$/, 'duplicate of another model (numbered copy)'],
];

const files = (dir, ext) =>
  existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort().map((f) => join(dir, f))
    : null;

// ---- 1. declared: keys under components.schemas of common/common.yaml ------
const declared = new Map(); // name -> file
// Aliases: schemas of `type: array` (e.g. a list of boards) or of a
// primitive type without `enum` (e.g. a raw webhook body, `type: string`).
// They give a body a name in the contract, but the generators resolve them to
// List<Board> / Array<Board> / String instead of emitting a
// model. They must be in the bundle, but are not expected in code.
const arrayAliases = new Set();
const schemaShape = new Map(); // name -> { type, hasEnum }
if (!existsSync(args.schemas) || !statSync(args.schemas).isFile()) {
  console.error(`${args.schemas} is not a file (expected common/common.yaml)`);
  process.exit(2);
}
{
  const file = args.schemas;
  let inComponents = false;
  let inSchemas = false;
  let current = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\S/.test(line) && !line.startsWith('#')) { inComponents = /^components:\s*(#.*)?$/.test(line); inSchemas = false; continue; }
    if (!inComponents) continue;
    if (/^ {2}[^\s#]/.test(line)) { inSchemas = /^ {2}schemas:\s*(#.*)?$/.test(line); continue; }
    if (!inSchemas) { current = null; continue; }
    const shape = current && schemaShape.get(current);
    const typeLine = shape && /^ {6}type:\s*([a-z]+)\s*(#.*)?$/.exec(line);
    if (typeLine) shape.type = typeLine[1];
    if (shape && /^ {6}enum:/.test(line)) shape.hasEnum = true;
    const m = /^ {4}([^\s#][^:]*):\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const name = m[1].trim().replace(/^['"]|['"]$/g, '');
    current = name;
    if (!schemaShape.has(current)) schemaShape.set(current, { type: null, hasEnum: false });
    if (declared.has(name)) {
      problem(`${name}: declared twice in ${file} — the bundler would rename one of them.`);
      continue;
    }
    declared.set(name, file);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) problem(`${name} (${file}): schema names are PascalCase, letters and digits only.`);
    if (RESERVED.has(name)) problem(`${name} (${file}): shadows a Kotlin/TypeScript type — pick a specific name (e.g. TaskStatus, not Status).`);
    for (const [pattern, what] of SYNTHETIC) {
      if (pattern.test(name)) problem(`${name} (${file}): looks like a generated name (${what}) — pick a real name.`);
    }
  }
}

for (const [name, { type, hasEnum }] of schemaShape) {
  if (type === 'array' || (['string', 'integer', 'number', 'boolean'].includes(type) && !hasEnum)) arrayAliases.add(name);
}

// ---- 2. bundle: components.schemas must be exactly the declared set --------
// (redocly names hoisted schemas after their key; a collision would show up as
// "Task-2", a schema defined outside common/common.yaml - e.g. in api/api.yaml -
// as an unknown name)
const bundled = new Set();
{
  const lines = readFileSync(args.bundle, 'utf8').split('\n');
  let inComponents = false;
  let inSchemas = false;
  for (const line of lines) {
    if (/^\S/.test(line)) { inComponents = line.startsWith('components:'); inSchemas = false; continue; }
    if (!inComponents) continue;
    if (/^ {2}\S/.test(line)) { inSchemas = line.startsWith('  schemas:'); continue; }
    const m = inSchemas && /^ {4}([^\s#][^:]*):\s*$/.exec(line);
    if (m) bundled.add(m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
}
for (const name of bundled) {
  if (!declared.has(name)) problem(`${name}: in the bundle but not under components.schemas in ${args.schemas} (renamed by the bundler, or defined elsewhere).`);
}
for (const [name, file] of declared) {
  if (!bundled.has(name)) problem(`${name} (${file}): declared but not used by any operation — remove it or reference it.`);
}

// Schemas of multipart/form-data bodies (e.g. BoardSnapshotUpload) are form
// descriptions: the generators turn their properties into parameters
// (@RequestPart file: MultipartFile / file: Blob) instead of emitting a model.
const formSchemas = new Set();
{
  const lines = readFileSync(args.bundle, 'utf8').split('\n');
  let formIndent = -1;
  for (const line of lines) {
    const indent = line.search(/\S/);
    if (formIndent >= 0 && indent >= 0 && indent <= formIndent) formIndent = -1;
    if (/^\s+multipart\/form-data:\s*$/.test(line)) { formIndent = indent; continue; }
    const ref = formIndent >= 0 && /\$ref:\s*['"]?#\/components\/schemas\/([A-Za-z0-9]+)/.exec(line);
    if (ref) formSchemas.add(ref[1]);
  }
}
// ---- 3. generated code ---------------------------------------------------------
function compare(language, generated) {
  // generated: Map name -> [files]
  for (const [name, where] of generated) {
    if (where.length > 1) problem(`${language}: ${name} is generated ${where.length} times (${where.join(', ')}).`);
    if (!declared.has(name)) {
      const why = SYNTHETIC.find(([pattern]) => pattern.test(name))?.[1] ?? `not declared in ${args.schemas}`;
      problem(`${language}: ${name} (${where[0]}) — ${why}. Give the schema its own key under components.schemas in ${args.schemas} and $ref it.`);
    }
  }
  for (const name of declared.keys()) {
    if (arrayAliases.has(name)) continue; // alias, resolved to List<…>/Array<…>/String
    if (formSchemas.has(name)) continue; // multipart form, flattened into parameters
    if (bundled.has(name) && !generated.has(name)) problem(`${language}: ${name} was not generated.`);
  }
  return generated.size;
}

const summary = [];

if (args.kotlin) {
  const kotlinFiles = files(args.kotlin, '.kt');
  if (!kotlinFiles) problem(`Kotlin: model directory ${args.kotlin} does not exist — run the generator first.`);
  else {
    const generated = new Map();
    for (const file of kotlinFiles) {
      const text = readFileSync(file, 'utf8');
      const top = [...text.matchAll(/^(?:data |enum |sealed |value |open |abstract )*(?:class|interface|object) +(\w+)/gm)].map((m) => m[1]);
      const nested = [...text.matchAll(/^[ \t]+(?:data |enum |sealed |value )*(?:class|interface) +(\w+)/gm)].map((m) => m[1]);
      for (const name of top) generated.set(name, [...(generated.get(name) ?? []), basename(file)]);
      for (const name of nested) {
        problem(`Kotlin: nested type ${top[0] ?? '?'}.${name} (${basename(file)}) — an inline enum/object in a property. Move it to its own key under components.schemas and $ref it.`);
      }
      if (top.length === 1 && `${top[0]}.kt` !== basename(file)) problem(`Kotlin: ${basename(file)} declares ${top[0]}.`);
    }
    summary.push(`Kotlin ${compare('Kotlin', generated)}`);
  }
}

if (args.typescript) {
  const tsFiles = files(args.typescript, '.ts');
  if (!tsFiles) problem(`TypeScript: model directory ${args.typescript} does not exist — run the generator first.`);
  else {
    const generated = new Map();
    for (const file of tsFiles) {
      if (basename(file) === 'models.ts') continue; // barrel file, re-exports only
      const text = readFileSync(file, 'utf8');
      // `export const ErrorCode = {...}; export type ErrorCode = ...` is ONE model
      const names = new Set([...text.matchAll(/^export (?:declare )?(?:interface|type|const|enum|class|namespace) +(\w+)/gm)].map((m) => m[1]));
      for (const name of names) generated.set(name, [...(generated.get(name) ?? []), basename(file)]);
      // inline enums end up in `export namespace Task { export const StatusEnum ... }`
      const nested = new Set([...text.matchAll(/^[ \t]+export (?:const|type|interface|enum) +(\w+)/gm)].map((m) => m[1]));
      for (const name of nested) {
        problem(`TypeScript: nested type ${[...names][0] ?? '?'}.${name} (${basename(file)}) — an inline enum/object in a property. Move it to its own key under components.schemas and $ref it.`);
      }
    }
    summary.push(`TypeScript ${compare('TypeScript', generated)}`);
  }
}

if (problems.length > 0) {
  console.error(`Generated models do not match ${args.schemas} (${problems.length} finding(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Generated models ok: ${declared.size} declared (${arrayAliases.size} aliases, ${formSchemas.size} multipart forms), generated ${summary.join(', ') || 'nothing checked'} — each exactly once, no synthetic names.`);
