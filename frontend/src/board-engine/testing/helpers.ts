import { BoardEngine, EngineOptions } from '../engine';
import { PointerInfo, pointerInfo } from '../input/events';
import { BoardDoc, Point, screenToWorld, worldToScreen } from '@apps/drawboard-engine';

/** An engine on a detached-from-layout container (jsdom has no layout: the viewport is unmeasured). */
export interface TestEngine {
  engine: BoardEngine;
  board: BoardDoc;
  container: HTMLElement;
  /** Pointer event at a world point (uses the engine's current camera). */
  at(x: number, y: number, extra?: Partial<PointerInfo>): PointerInfo;
  /** Press at (x1,y1), move through the optional points, release at the last point. */
  drag(from: Point, to: Point, extra?: Partial<PointerInfo>): void;
  click(x: number, y: number, extra?: Partial<PointerInfo>): void;
  key(key: string, mods?: { shift?: boolean; mod?: boolean; alt?: boolean }): boolean;
  destroy(): void;
}

export function createTestEngine(options: EngineOptions = {}, board = new BoardDoc()): TestEngine {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const engine = new BoardEngine(container, board, options);
  const at = (x: number, y: number, extra: Partial<PointerInfo> = {}): PointerInfo => {
    const screen = worldToScreen(engine.camera, { x, y });
    return pointerInfo({ screen, world: screenToWorld(engine.camera, screen), ...extra });
  };
  return {
    engine,
    board,
    container,
    at,
    drag(from, to, extra = {}) {
      engine.pointerDown(at(from.x, from.y, extra));
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        engine.pointerMove(
          at(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, extra),
        );
      }
      engine.pointerUp(at(to.x, to.y, { ...extra, buttons: 0 }));
    },
    click(x, y, extra = {}) {
      engine.pointerDown(at(x, y, extra));
      engine.pointerUp(at(x, y, { ...extra, buttons: 0 }));
    },
    key(key, mods = {}) {
      return engine.keyDown({ key, shift: false, alt: false, mod: false, repeat: false, ...mods });
    },
    destroy() {
      engine.destroy();
      board.destroy();
      container.remove();
    },
  };
}
