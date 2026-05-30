/**
 * @file platform/chrome/storage.ts
 *
 * Shared wrappers around local/session extension storage.
 */

type StorageValues = Record<string, unknown>;

export function hasLocalStorageArea(): boolean {
  return typeof chrome !== 'undefined'
    && !!chrome.storage
    && !!chrome.storage.local
    && typeof chrome.storage.local.get === 'function';
}

export function hasSessionStorageArea(): boolean {
  return typeof chrome !== 'undefined'
    && !!chrome.storage
    && !!chrome.storage.session
    && typeof chrome.storage.session.get === 'function';
}

export async function getLocalStorageValues(keys: string | string[]): Promise<StorageValues> {
  return await chrome.storage.local.get(keys as string[]) as StorageValues;
}

export async function setLocalStorageValues(values: StorageValues): Promise<void> {
  await chrome.storage.local.set(values);
}

export async function getSessionStorageValues(keys: string | string[]): Promise<StorageValues> {
  return await chrome.storage.session.get(keys as string[]) as StorageValues;
}

export async function setSessionStorageValues(values: StorageValues): Promise<void> {
  await chrome.storage.session.set(values);
}

export async function removeSessionStorageValues(keys: string | string[]): Promise<void> {
  await chrome.storage.session.remove(keys as string[]);
}

export type StorageChangedListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
) => void;

/**
 * Subscribes to storage change events. Returns true when the listener was
 * actually installed, false when the storage area is unavailable (e.g. in a
 * context without `chrome.storage`).
 */
export function addStorageChangedListener(listener: StorageChangedListener): boolean {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged?.addListener) return false;
  chrome.storage.onChanged.addListener(listener);
  return true;
}

export function removeStorageChangedListener(listener: StorageChangedListener): void {
  chrome.storage?.onChanged?.removeListener?.(listener);
}
