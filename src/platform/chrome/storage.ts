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
