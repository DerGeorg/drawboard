import { importableCopy } from './board-copy';
import { BoardFile, ImportError } from './board-file';

const block = (id: string, overrides: Record<string, unknown> = {}): BoardFile['blocks'][number] =>
  ({
    id,
    type: 'core.sticky',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    z: 0,
    parent: null,
    locked: false,
    props: { color: '#fde68a' },
    text: id,
    ...overrides,
  }) as BoardFile['blocks'][number];

const file = (blocks: BoardFile['blocks'], connectors: unknown[] = []): BoardFile =>
  ({ schemaVersion: 1, title: 'T', blocks, connectors, strokes: [] }) as unknown as BoardFile;

const plugin = new Set(['org.example.timer.clock']);

describe('importableCopy', () => {
  describe('block types', () => {
    it('when every block is fine then the file comes back unchanged and nothing is skipped', () => {
      const input = file([block('a'), block('b')]);

      const result = importableCopy(input);

      expect(result.file, 'file').toEqual(input);
      expect(result.skipped, 'skipped').toBe(0);
    });

    it('when a block has an unknown type then it is left out and counted instead of failing the copy', () => {
      const result = importableCopy(
        file([block('a'), block('b', { type: 'x.unknown', props: {} })]),
      );

      expect(
        result.file.blocks.map((b) => b.id),
        'blocks',
      ).toEqual(['a']);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when a plugin type is not enabled then its block is left out, when it is enabled it stays', () => {
      const input = file([
        block('a'),
        block('p', { type: 'org.example.timer.clock', props: { n: 1 } }),
      ]);

      expect(importableCopy(input).file.blocks.length, 'disabled').toBe(1);
      expect(importableCopy(input, { pluginTypes: plugin }).file.blocks.length, 'enabled').toBe(2);
    });

    it('when a plugin block has props that are not plain JSON keys then it is left out', () => {
      const input = file([
        block('p', {
          type: 'org.example.timer.clock',
          props: JSON.parse('{"__proto__":{"x":1}}'),
        }),
      ]);

      const result = importableCopy(input, { pluginTypes: plugin });

      expect(result.file.blocks, 'blocks').toEqual([]);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when a core.* type is claimed by a plugin list then it is still refused', () => {
      const result = importableCopy(file([block('a', { type: 'core.evil', props: {} })]), {
        pluginTypes: new Set(['core.evil']),
      });

      expect(result.skipped, 'skipped').toBe(1);
    });
  });

  describe('invalid content', () => {
    it('when a prop is invalid then only that block is left out', () => {
      const result = importableCopy(
        file([block('a'), block('b', { props: { color: 'url(https://evil.test)' } })]),
      );

      expect(
        result.file.blocks.map((b) => b.id),
        'blocks',
      ).toEqual(['a']);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when a block has a broken coordinate then it is left out', () => {
      const result = importableCopy(file([block('a', { x: Number.NaN })]));

      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when the schema version is unknown then the whole copy is refused', () => {
      expect(() => importableCopy({ ...file([block('a')]), schemaVersion: 99 }), 'refusal').toThrow(
        ImportError,
      );
    });

    it('when two blocks share an id then the whole copy is refused', () => {
      expect(() => importableCopy(file([block('a'), block('a')])), 'refusal').toThrow(ImportError);
    });
  });

  describe('links to left-out blocks', () => {
    it('when a connector ends at a left-out block then it is left out too', () => {
      const result = importableCopy(
        file(
          [block('a'), block('b', { type: 'x.unknown', props: {} })],
          [
            {
              id: 'c1',
              from: { block: 'a', anchor: 'auto' },
              to: { block: 'b', anchor: 'auto' },
              style: {},
              label: '',
            },
            {
              id: 'c2',
              from: { block: 'a', anchor: 'auto' },
              to: { x: 1, y: 1 },
              style: {},
              label: '',
            },
          ],
        ),
      );

      expect(
        result.file.connectors.map((c) => c.id),
        'connectors',
      ).toEqual(['c2']);
    });

    it('when a frame is left out then its children become top-level', () => {
      const result = importableCopy(
        file([
          block('f', { type: 'core.frame', props: { fill: 'url(x)' } }),
          block('child', { parent: 'f' }),
        ]),
      );

      expect(
        result.file.blocks.map((b) => [b.id, b.parent]),
        'blocks',
      ).toEqual([['child', null]]);
    });
  });

  describe('omitted types', () => {
    it('when a type is omitted on purpose then its blocks go without being counted', () => {
      const id = '0192f5e0-7c1a-7b3e-8f00-00000000000a';
      const result = importableCopy(
        file([
          block('a'),
          block('f', { type: 'core.file', props: { fileId: id }, text: undefined }),
        ]),
        { omitTypes: new Set(['core.file']) },
      );

      expect(
        result.file.blocks.map((b) => b.id),
        'blocks',
      ).toEqual(['a']);
      expect(result.skipped, 'skipped').toBe(0);
    });
  });

  describe('broken structure', () => {
    const frame = (id: string, parent: string | null = null): BoardFile['blocks'][number] =>
      block(id, { type: 'core.frame', props: { fill: '#ffffff' }, parent });

    it('when a parent link points at a block that does not exist then the block becomes top-level and is counted', () => {
      const result = importableCopy(file([block('a', { parent: 'ghost' })]));

      expect(
        result.file.blocks.map((b) => [b.id, b.parent]),
        'blocks',
      ).toEqual([['a', null]]);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when a parent is no frame then the link is cut and counted', () => {
      const result = importableCopy(file([block('a'), block('b', { parent: 'a' })]));

      expect(
        result.file.blocks.map((b) => b.parent),
        'parents',
      ).toEqual([null, null]);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when frames contain each other then the cycle is broken once and the rest keeps its links', () => {
      const result = importableCopy(
        file([frame('f1', 'f2'), frame('f2', 'f1'), block('child', { parent: 'f2' })]),
      );

      expect(
        result.file.blocks.map((b) => [b.id, b.parent]),
        'blocks',
      ).toEqual([
        ['f1', null],
        ['f2', 'f1'],
        ['child', 'f2'],
      ]);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when frames are nested deeper than allowed then the too deep link is cut', () => {
      const frames = Array.from({ length: 9 }, (_, i) =>
        frame(`f${i}`, i === 0 ? null : `f${i - 1}`),
      );

      const result = importableCopy(file(frames));

      expect(
        result.file.blocks.filter((b) => b.parent === null).map((b) => b.id),
        'top level',
      ).toEqual(['f0', 'f8']);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when a connector ends at a block that does not exist then it is left out and counted', () => {
      const result = importableCopy(
        file(
          [block('a')],
          [
            {
              id: 'c1',
              from: { block: 'a', anchor: 'auto' },
              to: { block: 'ghost', anchor: 'auto' },
              style: {},
              label: '',
            },
            {
              id: 'c2',
              from: { block: 'a', anchor: 'auto' },
              to: { x: 1, y: 1 },
              style: {},
              label: '',
            },
          ],
        ),
      );

      expect(
        result.file.connectors.map((c) => c.id),
        'connectors',
      ).toEqual(['c2']);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when a frame is left out and a grandchild hangs below it then nothing is counted twice', () => {
      const result = importableCopy(
        file([
          block('f', { type: 'core.frame', props: { fill: 'url(x)' } }),
          frame('inner', 'f'),
          block('leaf', { parent: 'inner' }),
        ]),
      );

      expect(
        result.file.blocks.map((b) => [b.id, b.parent]),
        'blocks',
      ).toEqual([
        ['inner', null],
        ['leaf', 'inner'],
      ]);
      expect(result.skipped, 'skipped').toBe(1);
    });

    it('when the structure is fine then nothing is changed or counted', () => {
      const input = file([frame('f'), block('a', { parent: 'f' })]);

      const result = importableCopy(input);

      expect(result.file, 'file').toEqual(input);
      expect(result.skipped, 'skipped').toBe(0);
    });
  });
});
