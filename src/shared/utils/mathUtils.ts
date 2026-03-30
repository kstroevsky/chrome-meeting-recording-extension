/**
 * @file shared/utils/mathUtils.ts
 *
 * Reusable utility functions for mathematics, time keeping, and boundaries.
 */

/** Returns a high-resolution monotonic timestamp in milliseconds if available, or Date.now. */
export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Rounds a number to exactly one decimal place. */
export function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Clamps a value strictly between a minimum and a maximum inclusive bound. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
