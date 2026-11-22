import { FileSource, NO_FILES } from '@apps/drawboard-engine';
import { BlockType, BlockTypeRegistry } from '../renderer/block-registry';
import { emojiBlock } from './emoji';
import { FileRenderers, createFileBlock } from './file';
import { GifServices, createGifBlock } from './gif';
import { frameBlock } from './frame';
import { STICKY_OUT, createKanbanBlock } from './kanban';
import { storyFromCard } from './kanban-story';
import { DiagramRenderer, createMermaidBlock } from './mermaid';
import { shapeBlock } from './shape';
import { stickyBlock } from './sticky';
import { EstimateSource, createStoryBlock } from './story';
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
  /**
   * GIFs from GIPHY (3.14): the instance switch, the viewer's consent, the view's mode. Without
   * it a GIF block is a placeholder and loads nothing.
   */
  gifs?: GifServices;
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
  register(emojiBlock);
  register(createGifBlock(services.gifs));
  register(frameBlock);
  register(createFileBlock(services.files ?? NO_FILES, services.fileRenderers));
  register(createMermaidBlock(services.diagrams));
  // a kanban card dropped onto the canvas with Shift becomes a story card
  register(
    createKanbanBlock({
      ...STICKY_OUT,
      alternative: storyFromCard,
    }),
  );
  register(createStoryBlock(services.estimates));
  return registry;
}
