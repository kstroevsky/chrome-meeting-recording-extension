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

export function isE2EMockCaptureBuild(): boolean {
  return (globalThis as any).__E2E_MOCK_CAPTURE__ === true;
}

export const E2E_MOCK_TAB_STREAM_ID = '__E2E_MOCK_TAB_CAPTURE__';
