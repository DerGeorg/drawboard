import '../../src/trusted-types'; // first, as in main.ts: the Trusted Types policies
// The rich-content side of content.spec.ts: the real Mermaid renderer and the real pdf.js view,
// bundled by esbuild with their lazy chunks and run under the production CSP.
import { MERMAID_TYPE } from '../../src/board-engine/blocks/mermaid';
import { mermaidRenderer } from '../../src/board-engine/diagrams/mermaid-renderer';
import { BoardEngine } from '../../src/board-engine/engine';
import type { FileSource } from '../../src/board-engine/files/file-source';
import { pdfRenderers } from '../../src/board-engine/files/pdf-view';
import { BoardDoc } from '../../src/board-engine/model/board-doc';
import { KANBAN_TYPE, newKanbanProps } from '../../src/board-engine/blocks/kanban-model';
import { STORY_TYPE, newStoryProps } from '../../src/board-engine/blocks/story-model';

const FILE_ID = '0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f';
const files: FileSource = {
  watch(_id, listener) {
    listener({
      status: 'ready',
      file: {
        id: FILE_ID,
        name: 'doc.pdf',
        mediaType: 'application/pdf',
        kind: 'PDF',
        size: 1000,
        conversion: 'NONE',
        pageCount: 2,
      },
      links: {
        url: `/files/${FILE_ID}?v=original&exp=1&sig=s`,
        originalUrl: `/files/${FILE_ID}?v=original&exp=1&sig=s`,
        expiresAt: Date.now() + 3_600_000,
      },
    });
    return () => undefined;
  },
  download: () => undefined,
  refresh: () => undefined,
};

const board = new BoardDoc();
const engine = new BoardEngine(document.getElementById('board') as HTMLElement, board, {
  services: {
    files,
    fileRenderers: pdfRenderers({ assetBase: '/pdfjs/' }),
    diagrams: mermaidRenderer(),
  },
});
board.addBlock({
  type: MERMAID_TYPE,
  x: 0,
  y: 0,
  w: 420,
  h: 260,
  text:
    '%%{init: {"securityLevel": "loose", "htmlLabels": true}}%%\n' +
    'flowchart LR\n  Idea --> Plan --> Build --> Ship\n  click Ship "javascript:alert(1)"',
});
board.addBlock({ type: 'core.file', x: 500, y: 0, w: 360, h: 480, props: { fileId: FILE_ID } });
// a second PDF: both documents share the one worker
board.addBlock({ type: 'core.file', x: 900, y: 0, w: 360, h: 480, props: { fileId: FILE_ID } });
board.addBlock({
  type: KANBAN_TYPE,
  x: 0,
  y: 560,
  w: 760,
  h: 440,
  props: newKanbanProps(),
});
board.addBlock({
  type: STORY_TYPE,
  x: 0,
  y: 1040,
  w: 300,
  h: 220,
  props: newStoryProps(),
  text: 'As a user I can sign in',
});
(window as unknown as { engine: BoardEngine }).engine = engine;
