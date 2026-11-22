import { TEXT_ON_PASTEL } from '@apps/drawboard-engine';

/**
 * The text editor over a block reads `--be-editor-bg` and `--be-editor-text` (set on the board
 * container per theme). A block whose fill stays light on the dark canvas overrides them on its
 * own element: dark text on a light veil, like in the light theme.
 */
export function setEditorColors(host: HTMLElement, light: boolean): void {
  if (light) {
    host.style.setProperty('--be-editor-bg', 'rgba(255, 255, 255, 0.55)');
    host.style.setProperty('--be-editor-text', TEXT_ON_PASTEL);
  } else {
    host.style.removeProperty('--be-editor-bg');
    host.style.removeProperty('--be-editor-text');
  }
}
