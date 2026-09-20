/**
 * @file shared/format.ts
 *
 * Small display formatters shared by popup and background-adjacent UI code.
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * A duration at the resolution it is actually known to: `~45s`, `~32m`, `~1.5h`.
 *
 * Used where the length was inferred rather than measured (design 8D), so the
 * tilde and the coarseness are the message: this is about how long it ran, and
 * a timecode would claim a precision that was never there.
 */
export function formatApproximateDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `~${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes}m`;
  const hours = minutes / 60;
  // One decimal, and none when it would read `2.0h`.
  const rounded = Math.round(hours * 10) / 10;
  return `~${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}h`;
}

