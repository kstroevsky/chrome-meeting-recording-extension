/**
 * @file offscreen/errors.ts
 *
 * Small runtime-error formatting helpers shared by the offscreen recording and
 * persistence pipeline. These helpers intentionally produce short, structured
 * strings that are useful in DevTools logs and popup alerts.
 */

/**
 * Converts DOMException / Error / unknown values into a stable single-line
 * string for logging and user-visible fallback status.
 */
export function describeRuntimeError(err: unknown): string {
  const e = err as any;
  const name = e?.name || 'Error';
  const message = e?.message || String(e);
  const code = e?.code != null ? ` code=${e.code}` : '';
  return `${name}: ${message}${code}`;
}
