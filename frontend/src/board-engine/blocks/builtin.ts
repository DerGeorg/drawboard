import { FileSource, NO_FILES } from '../files/file-source';
import { BlockType, BlockTypeRegistry } from '../renderer/block-registry';
import { FileRenderers, createFileBlock } from './file';
import { frameBlock } from './frame';
import { STICKY_OUT, createKanbanBlock } from './kanban';
import { DiagramRenderer, createMermaidBlock } from './mermaid';
import { shapeBlock } from './shape';
import { stickyBlock } from './sticky';
import { EstimateSource, createStoryBlock } from './story';
import { STORY_TYPE, newStoryProps } from './story-model';
import { textBlock } from './text';

/**
 * What built-in blocks need from the host. Absent services degrade gracefully: without a file
 * source every file block shows "not available", without a diagram renderer a diagram shows
 * its source (data-URL boards, tests).
 */
export interface BuiltinServices {
  files?: FileSource;
  fileRenderers?: FileRenderers;
  /** Sanitising Mermaid renderer; without it a diagram block shows its source as text. */
  diagrams?: DiagramRenderer;
  /** Open planning poker rounds per story card; without it no card shows "estimating". */
  estimates?: EstimateSource;
}

/**
 * Registers the built-in block types through the public registry (same path as plugins). These
 * are the only trusted block types (S3.1): they ship in the image; nothing installed at runtime
 * is ever registered here.
 */
export function registerBuiltinBlocks(
  registry: BlockTypeRegistry,
  services: BuiltinServices = {},
): BlockTypeRegistry {
  // the one place that marks a type as trusted: only these get the BlockHost (SHOULD 1)
  const register = (type: BlockType): void => registry.register({ ...type, trusted: true });
  register(stickyBlock);
  register(textBlock);
  register(shapeBlock);
  register(frameBlock);
  register(createFileBlock(services.files ?? NO_FILES, services.fileRenderers));
  register(createMermaidBlock(services.diagrams));
  // a kanban card dropped onto the canvas with Shift becomes a story card
  register(
    createKanbanBlock({
      ...STICKY_OUT,
      alternative: (card, at) => ({
        type: STORY_TYPE,
        x: at.x - 150,
        y: at.y - 110,
        w: 300,
        h: 220,
        props: { ...newStoryProps(), estimate: card.points === null ? null : String(card.points) },
        text: card.title,
      }),
    }),
  );
  register(createStoryBlock(services.estimates));
  return registry;
}
