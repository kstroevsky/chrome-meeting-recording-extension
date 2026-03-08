/**
 * @file offscreen/RecorderSupport.ts
 *
 * Small recorder-focused error formatting helpers.
 */

export function describeMediaError(err: unknown): string {
  const error = err as any;
  const name = error?.name || 'Error';
  const message = error?.message || String(error);
  const constraint = error?.constraint ? ` constraint=${error.constraint}` : '';
  const code = error?.code != null ? ` code=${error.code}` : '';
  return `${name}: ${message}${constraint}${code}`;
}
