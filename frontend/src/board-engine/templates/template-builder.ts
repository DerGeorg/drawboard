import { KANBAN_TYPE } from '../blocks/kanban-model';
import { STORY_TYPE } from '../blocks/story-model';
import type { BoardFile, FileBlock } from '../io/board-file';
import { FRAME_TYPE } from '../model/frames';
import { SCHEMA_VERSION } from '../model/types';

/** A lowercase UUID with a counter in it: kanban and story ids must look like UUIDs (S5.5). */
export function templateUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

interface Place {
  /** Id of the frame the block sits in. */
  in?: string;
}

/**
 * Builds the board file of a built-in template. Blocks get ids `b1`, `b2` ... and a rising `z`,
 * so a template is a few readable lines per block. The result still goes through
 * `parseBoardFile` in the tests, like every import.
 */
export class TemplateBuilder {
  private readonly blocks: FileBlock[] = [];
  private nextUuid = 1;

  constructor(private readonly title: string) {}

  /** A frame: an area with a title and a pale fill. Returns its id. */
  frame(title: string, x: number, y: number, w: number, h: number, fill: string, p: Place = {}) {
    return this.add(FRAME_TYPE, x, y, w, h, { fill }, p, title);
  }

  /** Free text; `size` is the font size. */
  text(text: string, x: number, y: number, w: number, h: number, size = 18, p: Place = {}) {
    return this.add('core.text', x, y, w, h, { color: '#334155', fontSize: size }, p, text);
  }

  /** A hint under a frame title: small and grey. */
  hint(text: string, x: number, y: number, w: number, p: Place = {}) {
    return this.add('core.text', x, y, w, 52, { color: '#64748b', fontSize: 16 }, p, text);
  }

  sticky(text: string, x: number, y: number, w: number, h: number, color: string, p: Place = {}) {
    return this.add('core.sticky', x, y, w, h, { color }, p, text);
  }

  shape(
    kind: 'rect' | 'ellipse' | 'diamond',
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    p: Place = {},
  ) {
    return this.add('core.shape', x, y, w, h, { kind, fill, stroke: '#475569' }, p, text);
  }

  kanban(title: string, columns: readonly string[], x: number, y: number, w: number, h: number) {
    const props = {
      title,
      columns: columns.map((name, i) => ({
        id: templateUuid(this.nextUuid++),
        title: name,
        order: i + 1,
      })),
      cards: [],
    };
    return this.add(KANBAN_TYPE, x, y, w, h, props, {});
  }

  story(
    title: string,
    description: string,
    criteria: readonly string[],
    x: number,
    y: number,
    p: Place = {},
  ) {
    const props = {
      description,
      criteria: criteria.map((text) => ({
        id: templateUuid(this.nextUuid++),
        text,
        done: false,
      })),
      estimate: null,
    };
    return this.add(STORY_TYPE, x, y, 300, 220, props, p, title);
  }

  build(): BoardFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      title: this.title,
      blocks: this.blocks,
      connectors: [],
      strokes: [],
    };
  }

  private add(
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    props: Record<string, unknown>,
    place: Place,
    text?: string,
  ): string {
    const id = `b${this.blocks.length + 1}`;
    this.blocks.push({
      id,
      type,
      x,
      y,
      w,
      h,
      rotation: 0,
      z: type === FRAME_TYPE ? this.blocks.length : 1000 + this.blocks.length,
      parent: place.in ?? null,
      locked: false,
      props,
      ...(text === undefined ? {} : { text }),
    });
    return id;
  }
}
