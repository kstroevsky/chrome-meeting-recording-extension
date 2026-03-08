/**
 * @file shared/build.ts
 *
 * Build/runtime environment helpers used by popup, diagnostics, and tests.
 */

export function isDevBuild(): boolean {
  return (globalThis as any).__DEV_BUILD__ === true;
}

export function isTestRuntime(): boolean {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
}
