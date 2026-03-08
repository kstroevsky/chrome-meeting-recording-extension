export function isDevBuild(): boolean {
  return (globalThis as any).__DEV_BUILD__ === true;
}

export function isTestRuntime(): boolean {
  return typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
}
