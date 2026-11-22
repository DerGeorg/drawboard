// @ts-check
import eslint from '@eslint/js';
import ci from '@ci/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * @ci/eslint-plugin has no flat config for plain TypeScript (configs.angular is Angular-only), so
 * the base is the frontend's: @eslint/js + typescript-eslint recommended and stylistic. From the
 * plugin comes configs.tests (Vitest specs: "when … [given …] then …", nested describe, a message
 * on every expect). angular-eslint is installed only because the plugin imports it as a peer.
 *
 * The package is the DOM-free core of the board engine: the block for src/ is the frontend's
 * block for the core files (eslint.config.mjs there), so both refuse the same things.
 * src/core.spec.ts walks the import graph from core.ts and fails on what slips through here.
 */
export default defineConfig([
  { ignores: ['dist/', 'coverage/', 'junit/', '.ci/'] },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    files: ['**/*.mjs'],
    extends: [eslint.configs.recommended],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@angular/*', 'rxjs', 'rxjs/*'],
              message: 'The board engine has no Angular and no RxJS.',
            },
            {
              regex:
                '^\\.\\.?/(.*/)?(blocks|renderer|input|tools|diagrams)(/|$)|^\\.\\.?/(.*/)?(engine|scene|selection|grid|undo|index|text-editor|pdf-view|plugin-host|plugin-instance|gif-consent|gif-slots|follow|presence-binding|fit-text|safe-text)(\\.js)?$',
              message: 'The engine core is DOM-free: it must not import the view side.',
            },
            {
              regex: '^\\.\\.?/(.*/)?testing/',
              message: 'Test helpers are not part of the package.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...[
          'document',
          'window',
          'navigator',
          'localStorage',
          'sessionStorage',
          'HTMLElement',
          'Element',
          'Node',
          'DOMParser',
          'OffscreenCanvas',
          'IntersectionObserver',
          'ResizeObserver',
          'MutationObserver',
          'requestAnimationFrame',
          'getComputedStyle',
        ].map((name) => ({ name, message: 'The engine core is DOM-free (it runs in Node too).' })),
      ],
      '@typescript-eslint/no-restricted-types': [
        'error',
        {
          types: Object.fromEntries(
            [
              'Document',
              'Window',
              'Element',
              'HTMLElement',
              'SVGElement',
              'Node',
              'CanvasRenderingContext2D',
              'KeyboardEvent',
              'PointerEvent',
              'MouseEvent',
            ].map((name) => [name, 'The engine core is DOM-free (it runs in Node too).']),
          ),
        },
      ],
    },
  },
  ...ci.configs.tests,
]);
