import { getStroke } from 'perfect-freehand';

import { StrokeData } from '@apps/drawboard-engine';

/** SVG path data of the filled outline of a freehand stroke (perfect-freehand, MIT). */
export function strokePath(stroke: StrokeData): string {
  const pts: number[][] = [];
  const pressures = new Set<number>();
  for (let i = 0; i + 1 < stroke.points.length; i += 3) {
    const pressure = stroke.points[i + 2] ?? 0.5;
    pressures.add(pressure);
    pts.push([stroke.points[i] ?? 0, stroke.points[i + 1] ?? 0, pressure]);
  }
  if (pts.length === 0) {
    return '';
  }
  const outline = getStroke(pts, {
    size: stroke.style.size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    // mice report a constant pressure: let the library simulate it from the speed
    simulatePressure: pressures.size <= 1,
  });
  return outlineToPath(outline);
}

export function outlineToPath(outline: number[][]): string {
  if (outline.length < 4) {
    const p = outline[0];
    return p ? `M${p[0]} ${p[1]}` : '';
  }
  const parts: string[] = [`M${outline[0]?.[0]} ${outline[0]?.[1]} Q`];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i] ?? [0, 0];
    const b = outline[(i + 1) % outline.length] ?? [0, 0];
    parts.push(
      `${a[0]} ${a[1]} ${((a[0] ?? 0) + (b[0] ?? 0)) / 2} ${((a[1] ?? 0) + (b[1] ?? 0)) / 2}`,
    );
  }
  parts.push('Z');
  return parts.join(' ');
}
