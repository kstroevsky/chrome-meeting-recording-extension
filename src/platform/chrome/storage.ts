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

// The wrappers below degrade to a no-op (empty read) when the storage area is
// unavailable instead of throwing `Cannot read properties of undefined (reading
// 'local')`, because the stop/finalize pipeline must not abort a recording just
// because a bookkeeping write could not be persisted.
//
// **Know what that costs before using these for durable state.** The host that
// lacks `chrome.storage` is the **offscreen document** — its `chrome` object is
// `runtime` only — which is where capture, uploads and analysis all run. There,
// these wrappers make a write look successful while storing nothing, which is
// how the upload outbox and the crash-recovery markers were silently inert for
// months. Durable state owned by the offscreen document belongs in IndexedDB;
// see `offscreen/storage/indexedDbKeyValueArea.ts`.

export async function getLocalStorageValues(keys: string | string[]): Promise<StorageValues> {
  if (!hasLocalStorageArea()) return {};
  return await chrome.storage.local.get(keys as string[]) as StorageValues;
}

export async function setLocalStorageValues(values: StorageValues): Promise<void> {
  if (!hasLocalStorageArea()) return;
  await chrome.storage.local.set(values);
}

export async function getAllLocalStorageValues(): Promise<StorageValues> {
  if (!hasLocalStorageArea()) return {};
  return await chrome.storage.local.get(null) as StorageValues;
}

export async function removeLocalStorageValues(keys: string | string[]): Promise<void> {
  if (!hasLocalStorageArea()) return;
  await chrome.storage.local.remove(keys as string[]);
}

export async function getSessionStorageValues(keys: string | string[]): Promise<StorageValues> {
  if (!hasSessionStorageArea()) return {};
  return await chrome.storage.session.get(keys as string[]) as StorageValues;
}

/** Strict background-owned durable session read: absence is an error, not idle state. */
export async function getSessionStorageValuesStrict(
  keys: string | string[],
): Promise<StorageValues> {
  if (!hasSessionStorageArea()) throw new Error('chrome.storage.session is unavailable');
  return await chrome.storage.session.get(keys as string[]) as StorageValues;
}

export async function setSessionStorageValues(values: StorageValues): Promise<void> {
  if (!hasSessionStorageArea()) return;
  await chrome.storage.session.set(values);
}

/** Strict background-owned durable session write: never report success on a no-op. */
export async function setSessionStorageValuesStrict(values: StorageValues): Promise<void> {
  if (!hasSessionStorageArea()) throw new Error('chrome.storage.session is unavailable');
  await chrome.storage.session.set(values);
}

export async function removeSessionStorageValues(keys: string | string[]): Promise<void> {
  if (!hasSessionStorageArea()) return;
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
