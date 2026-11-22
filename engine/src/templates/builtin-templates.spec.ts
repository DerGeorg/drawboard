import { importableCopy } from '../io/board-copy.js';
import { ImportError, boardToFile, parseBoardFile, writeBoardFile } from '../io/board-file.js';
import { BoardDoc } from '../model/board-doc.js';
import { FRAME_TYPE } from '../model/frames.js';
import { BUILTIN_TEMPLATES, templateFile } from './builtin-templates.js';
import { previewOf } from './template-preview.js';

describe('built-in templates', () => {
  describe('list', () => {
    it('when the list is read then it holds the eight templates of the design', () => {
      expect(
        BUILTIN_TEMPLATES.map((t) => t.id),
        'ids',
      ).toEqual([
        'retro-start-stop-continue',
        'retro-mad-sad-glad',
        'retro-4l',
        'kanban',
        'sprint-planning',
        'brainstorming',
        'user-story-map',
        'swot',
      ]);
    });

    it('when the templates are listed then ids and titles are unique and every one has a description', () => {
      expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size, 'unique ids').toBe(
        BUILTIN_TEMPLATES.length,
      );
      expect(new Set(BUILTIN_TEMPLATES.map((t) => t.title)).size, 'unique titles').toBe(
        BUILTIN_TEMPLATES.length,
      );
      expect(
        BUILTIN_TEMPLATES.filter((t) => t.description.trim() === ''),
        'without description',
      ).toEqual([]);
    });
  });

  describe.each(BUILTIN_TEMPLATES.map((t) => [t.title, t] as const))('%s', (_title, template) => {
    it('when it goes through the import validation then there is no error and nothing changes', () => {
      // JSON in between: exactly what a .drawboard file would carry
      const json: unknown = JSON.parse(JSON.stringify(template.file));

      expect(() => parseBoardFile(json), 'import validation').not.toThrow(ImportError);
      expect(parseBoardFile(json), 'validated copy').toEqual(template.file);
    });

    it('when its blocks are listed then it holds no file, no plugin type and no text on a type without text', () => {
      const types = template.file.blocks.map((b) => b.type);
      const textOnTextless = template.file.blocks.filter(
        (b) => (b.type === 'core.kanban' || b.type === 'core.file') && b.text !== undefined,
      );

      expect(types, 'no file block').not.toContain('core.file');
      expect(
        types,
        'no GIF block (T7, G11): a template never makes a request of its own',
      ).not.toContain('core.gif');
      expect(
        types.filter((t) => !t.startsWith('core.')),
        'plugin types',
      ).toEqual([]);
      expect(textOnTextless, 'text on a type without text').toEqual([]);
    });

    it('when it is copied the way the app copies it then nothing is left out', () => {
      const result = importableCopy(template.file);

      expect(result.skipped, 'skipped').toBe(0);
      expect(result.file, 'validated file').toEqual(template.file);
    });

    it('when it is written into a board then reading the board gives the same file back', () => {
      const board = new BoardDoc();

      writeBoardFile(board, templateFile(template));

      const back = boardToFile(board, template.title);
      expect(back.blocks.map((b) => b.id).sort(), 'blocks').toEqual(
        template.file.blocks.map((b) => b.id).sort(),
      );
      expect(back.title, 'title').toBe(template.title);
    });

    it('when its blocks are read then children lie inside their frame and no type is a plugin type', () => {
      const byId = new Map(template.file.blocks.map((b) => [b.id, b]));
      const problems: string[] = [];

      for (const b of template.file.blocks) {
        if (!b.type.startsWith('core.') || b.type === 'core.emoji') {
          problems.push(`${b.id} has the type ${b.type}`);
        }
        const frame = b.parent === null ? undefined : byId.get(b.parent);
        if (b.parent !== null && frame?.type !== FRAME_TYPE) {
          problems.push(`${b.id} has no frame as parent`);
        } else if (
          frame &&
          (b.x < frame.x ||
            b.y < frame.y ||
            b.x + b.w > frame.x + frame.w ||
            b.y + b.h > frame.y + frame.h)
        ) {
          problems.push(`${b.id} sticks out of its frame`);
        }
      }

      expect(problems, 'problems').toEqual([]);
    });

    it('when its frames are compared then no two top-level frames overlap', () => {
      const frames = template.file.blocks.filter((b) => b.type === FRAME_TYPE && b.parent === null);
      const overlaps: string[] = [];

      for (const [i, a] of frames.entries()) {
        for (const b of frames.slice(i + 1)) {
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          if (!apart) {
            overlaps.push(`${a.id} and ${b.id}`);
          }
        }
      }

      expect(overlaps, 'overlapping frames').toEqual([]);
    });

    it('when the preview is made then it has shapes inside its box', () => {
      const preview = previewOf(template.file);
      const outside = preview.shapes.filter(
        (s) => s.x + s.w > preview.width + 0.01 || s.y + s.h > preview.height + 0.01,
      );

      expect(preview.shapes.length, 'shapes').toBeGreaterThan(0);
      expect(outside, 'shapes outside the box').toEqual([]);
    });
  });

  describe('helpers', () => {
    it('when a template file is copied then the copy shares no object with the template', () => {
      const template = BUILTIN_TEMPLATES[0];

      const copy = templateFile(template);
      copy.blocks[0].x = 12345;

      expect(template.file.blocks[0].x, 'template untouched').not.toBe(12345);
    });

    it('when an empty file is previewed then the preview has no shapes', () => {
      expect(
        previewOf({ schemaVersion: 1, title: '', blocks: [], connectors: [], strokes: [] }).shapes,
        'shapes',
      ).toEqual([]);
    });
  });
});
