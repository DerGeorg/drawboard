import { defineConfig } from 'vitest/config';

/** The one spec that needs a page address: it checks the provider's default WebSocket origin. */
const PAGE_SPECS = ['src/collab/provider.spec.ts'];

/**
 * Vitest in Node, without a DOM: the package has to work in Node (MCP server, desktop app), so
 * its specs run there. Thresholds as in the frontend (angular.json, architect.test.options).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    reporters: ['default', 'junit'],
    outputFile: { junit: 'junit/unit-results.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/**/*.d.ts', 'src/testing/**'],
      reporter: ['text-summary', 'cobertura', 'html'],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['src/**/*.spec.ts'], exclude: PAGE_SPECS },
      },
      {
        // Still Node: only `location` is set, as a page on localhost has it.
        extends: true,
        test: { name: 'page', include: PAGE_SPECS, setupFiles: ['src/testing/page-location.ts'] },
      },
    ],
  },
});
