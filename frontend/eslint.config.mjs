// @ts-check
import eslint from '@eslint/js';
import ci from '@ci/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * House rules come from @ci/eslint-plugin (repository ci/eslint-rules):
 *   configs.angular  modern Angular APIs only, one .html + .spec.ts per component (a style file
 *                    only when the template would become unreadable - then plain .css)
 *   configs.tests    Vitest specs: "when … [given …] then …", nested describe, message on every expect
 *   configs.e2e      Playwright specs under e2e/ with the same naming and message rules
 *   configs.tracing  user actions carry @WithSpan('<Class>.<method>') (with-span-on-actions)
 * The selector prefix comes from angular.json ("prefix") - configs.angular reads it since 1.4.
 * This file only adds the language basics and the project root for typed linting.
 */
export default defineConfig([
  {
    ignores: [
      'dist/',
      'coverage/',
      'junit/',
      '.angular/',
      'test-results/',
      'playwright-report/',
      'e2e/.auth/',
      'sourcemaps/',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended, tseslint.configs.stylistic],
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    // The board engine is plain TypeScript: Angular only hosts it (docs/board-engine.md).
    files: ['src/board-engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@angular/*', 'rxjs', 'rxjs/*'],
              message: 'The board engine has no Angular and no RxJS.',
            },
            { group: ['**/app/**'], message: 'The board engine must not import the Angular app.' },
          ],
        },
      ],
    },
  },
  {
    // The plugin SDK is what plugin authors bundle into their frame: it stands alone (its specs
    // run it against the real board host).
    files: ['src/plugin-sdk/**/*.ts'],
    ignores: ['src/plugin-sdk/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@angular/*', 'rxjs', 'rxjs/*', '@apps/*'],
              message: 'The plugin SDK has no dependencies.',
            },
            {
              group: ['**/app/**', '**/board-engine/**'],
              message: 'The plugin SDK must not import the board.',
            },
          ],
        },
      ],
    },
  },
  ...ci.configs.angular,
  ...ci.configs.tests,
  ...ci.configs.e2e,
  ...ci.configs.tracing,
]);
