import { Point } from '@apps/drawboard-engine';

/** A pointer event normalized by the engine; tools never see DOM events. */
export interface PointerInfo {
  /** Position in container pixels. */
  screen: Point;
  /** Position in world coordinates. */
  world: Point;
  /** Bit field like `PointerEvent.buttons` (1 = primary, 2 = secondary, 4 = middle). */
  buttons: number;
  shift: boolean;
  alt: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  mod: boolean;
  pointerId: number;
  pressure: number;
  /** Click count (2 = double click) where the platform tells. */
  detail: number;
  /** The pointer is a finger or pen rather than a mouse. */
  touch: boolean;
}

export interface KeyInfo {
  key: string;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  repeat: boolean;
  /** `KeyboardEvent.code` (the physical key, e.g. `Digit1`): layout-independent shortcuts. */
  code?: string;
}

export interface WheelInfo {
  screen: Point;
  deltaX: number;
  deltaY: number;
  /** Mod key held, or a trackpad pinch (browsers send those as ctrl+wheel). */
  zoom: boolean;
}

export function pointerInfo(
  partial: Partial<PointerInfo> & { screen: Point; world: Point },
): PointerInfo {
  return {
    buttons: 1,
    shift: false,
    alt: false,
    mod: false,
    pointerId: 1,
    pressure: 0.5,
    detail: 1,
    touch: false,
    ...partial,
  };
}
