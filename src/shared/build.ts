/**
 * @file shared/build.ts
 *
 * Build/runtime environment helpers used by popup, diagnostics, and tests.
 */

export function isDevBuild(): boolean {
  return (globalThis as any).__DEV_BUILD__ === true;
}

/** Unique per-build identifier stamped in by webpack; '' when unavailable (e.g. tests). */
export function getBuildId(): string {
  return (globalThis as any).__BUILD_ID__ ?? '';
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

/**
 * Enables the normal extension-tab recorder host used only by the live
 * Playwright tier. Capture and devices remain real; only the runtime context
 * differs from production's offscreen document.
 */
export function isE2ERealCaptureTabBuild(): boolean {
  if (typeof __E2E_REAL_CAPTURE_TAB_BUILD__ !== 'undefined') {
    return __E2E_REAL_CAPTURE_TAB_BUILD__ === true;
  }
  return (globalThis as any).__E2E_REAL_CAPTURE_TAB__ === true;
}
