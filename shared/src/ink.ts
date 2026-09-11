/**
 * Ink stroke encoding.
 *
 * Pen input arrives as floats, and floats from two devices never serialise to
 * the same bytes. Strokes are therefore quantised to integers on the way in:
 * position to hundredths of a point, pressure to thousandths, time to
 * milliseconds relative to the first sample.
 */

export const POSITION_SCALE = 100;
export const PRESSURE_SCALE = 1000;
export const STRIDE = 4;

export interface InkPoint {
  x: number;
  y: number;
  /** 0..1 */
  pressure: number;
  /** Milliseconds since the first sample of the stroke. */
  t: number;
}

export class InkError extends Error {}

function quantize(value: number, scale: number, label: string): number {
  if (!Number.isFinite(value)) throw new InkError(`non-finite ${label} in ink stroke`);
  return Math.round(value * scale);
}

/** Encodes points to the flat integer array stored in `InkStroke.points`. */
export function encodeStroke(points: readonly InkPoint[]): number[] {
  const out: number[] = [];
  const origin = points[0]?.t ?? 0;
  for (const point of points) {
    out.push(
      quantize(point.x, POSITION_SCALE, 'x'),
      quantize(point.y, POSITION_SCALE, 'y'),
      quantize(Math.min(1, Math.max(0, point.pressure)), PRESSURE_SCALE, 'pressure'),
      Math.max(0, Math.round(point.t - origin)),
    );
  }
  return out;
}

export function decodeStroke(points: readonly number[]): InkPoint[] {
  if (points.length % STRIDE !== 0) throw new InkError(`ink stroke length ${points.length} is not a multiple of ${STRIDE}`);
  const out: InkPoint[] = [];
  for (let i = 0; i < points.length; i += STRIDE) {
    out.push({
      x: points[i]! / POSITION_SCALE,
      y: points[i + 1]! / POSITION_SCALE,
      pressure: points[i + 2]! / PRESSURE_SCALE,
      t: points[i + 3]!,
    });
  }
  return out;
}

/** Number of samples in an encoded stroke. */
export function strokeLength(points: readonly number[]): number {
  return Math.floor(points.length / STRIDE);
}
