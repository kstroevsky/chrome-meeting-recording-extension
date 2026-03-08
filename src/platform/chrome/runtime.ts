/**
 * @file platform/chrome/runtime.ts
 *
 * Shared wrappers for Chrome runtime messaging, ports, and manifest helpers.
 */

export function connectRuntimePort(name: string): chrome.runtime.Port {
  return chrome.runtime.connect({ name });
}

export async function sendRuntimeMessage<T = unknown>(message: unknown): Promise<T> {
  return await chrome.runtime.sendMessage(message) as T;
}

export async function trySendRuntimeMessage(message: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {}
}

export function getRuntimeUrl(path: string): string {
  return chrome.runtime.getURL(path);
}

export function getRuntimeManifest(): chrome.runtime.Manifest {
  return chrome.runtime.getManifest();
}

export function getRuntimeId(): string | null {
  return chrome.runtime.id ?? null;
}

export function pokeRuntime(): void {
  chrome.runtime.getPlatformInfo(() => {});
}
