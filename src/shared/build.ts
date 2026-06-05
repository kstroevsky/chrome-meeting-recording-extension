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
  if (typeof __E2E_MOCK_CAPTURE_BUILD__ !== 'undefined') {
    return __E2E_MOCK_CAPTURE_BUILD__ === true;
  }
  return (globalThis as any).__E2E_MOCK_CAPTURE__ === true;
}

export function isE2EMockDriveBuild(): boolean {
  if (typeof __E2E_MOCK_DRIVE_BUILD__ !== 'undefined') {
    return __E2E_MOCK_DRIVE_BUILD__ === true;
  }
  return (globalThis as any).__E2E_MOCK_DRIVE__ === true;
}
