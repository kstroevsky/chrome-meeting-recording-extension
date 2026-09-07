/**
 * @file background/storageDurability.ts
 *
 * Reports what the retained library costs.
 *
 * Durability is already handled, by the `unlimitedStorage` permission in the
 * manifest: for an extension that exempts storage from both quota limits and
 * storage-pressure eviction, and Chrome's permission reference names the Origin
 * Private File System among the mechanisms it covers. So the library is not at
 * risk of being cleared under disk pressure, and nothing here needs to make it
 * safe.
 *
 * `navigator.storage.persisted()` reports something else — the web
 * StorageManager grant — and it reads false for this extension in every context
 * tried. That is not a durability signal here, and must not be presented as
 * one. It is surfaced only as a diagnostic.
 *
 * What `unlimitedStorage` does *not* cover: uninstalling the extension, the
 * user clearing site data, profile loss, disk failure. The library is retained
 * storage, not a backup.
 */

import type { StorageUsage } from '../shared/playback';

export type { StorageUsage };

/**
 * Asks for the StorageManager grant as belt-and-braces, and reports whether it
 * was given.
 *
 * Not load-bearing: `unlimitedStorage` already exempts this extension's storage
 * from eviction. A refusal is therefore unremarkable and is logged quietly
 * rather than warned about — an earlier version of this file treated a refusal
 * as "recordings may be evicted", which was wrong.
 */
export async function ensurePersistentStorage(
  log: (...args: unknown[]) => void,
  warn: (...args: unknown[]) => void,
): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    const granted = await navigator.storage.persist();
    // Eviction safety comes from `unlimitedStorage`, so neither outcome is a
    // problem worth a warning.
    log(granted
      ? 'StorageManager persistence granted'
      : 'StorageManager persistence not granted; unlimitedStorage still exempts extension storage');
    return granted;
  } catch (error) {
    warn('Could not request storage persistence:', error);
    return false;
  }
}

export async function readStorageUsage(
  retainedBytes: () => Promise<number>,
): Promise<StorageUsage> {
  const [persisted, estimate, retained] = await Promise.all([
    navigator.storage?.persisted?.().catch(() => false) ?? Promise.resolve(false),
    navigator.storage?.estimate?.().catch(() => undefined) ?? Promise.resolve(undefined),
    retainedBytes().catch(() => 0),
  ]);
  return {
    persisted: Boolean(persisted),
    ...(estimate?.usage != null ? { usageBytes: estimate.usage } : {}),
    ...(estimate?.quota != null ? { quotaBytes: estimate.quota } : {}),
    retainedBytes: retained,
  };
}
