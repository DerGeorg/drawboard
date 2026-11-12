import { Plugin } from '@apps/drawboard-api';

/** An installed plugin as an admin sees it; override what the test is about. */
export function aPlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: 'org.example.counter',
    name: 'Counter',
    version: '1.0.0',
    description: 'Counts things.',
    enabled: false,
    installedAt: '2026-11-10T10:00:00Z',
    installedBy: 'id-alice',
    bundleSha384: 'f'.repeat(96),
    assetBase: `/plugin-assets/org.example.counter/1.0.0/${'a'.repeat(64)}/`,
    blockTypes: [
      {
        type: 'org.example.counter.counter',
        label: 'Counter',
        defaultWidth: 200,
        defaultHeight: 100,
      },
    ],
    requestedCapabilities: [
      { name: 'block.props' },
      { name: 'storage' },
      { name: 'network', value: 'api.example.org tiles.example.org:8443' },
    ],
    grantedCapabilities: [{ name: 'block.props' }],
    revision: 3,
    ...overrides,
  };
}
