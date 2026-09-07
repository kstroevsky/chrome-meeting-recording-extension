/**
 * @file background/storageDurability.ts
 *
 * Makes the retained library durable, and reports what it costs.
 *
 * `unlimitedStorage` lifts the quota; it does not stop eviction. Without a
 * persistence grant the origin is "best-effort", and Chrome may clear it under
 * storage pressure — which would quietly delete the recordings ADR-0006 calls
 * retained. Asking for the grant is the difference between a library and a
 * cache that has not been cleared yet.
 */

export type StorageUsage = {
  /** True once the origin is exempt from eviction under storage pressure. */
  persisted: boolean;
  /** Bytes this origin uses, across OPFS and IndexedDB; undefined if unavailable. */
  usageBytes?: number;
  quotaBytes?: number;
  /** Bytes held by the retained library specifically — what a cleanup would free. */
  retainedBytes: number;
};

/**
 * Requests persistence once, and reports the result.
 *
 * Chrome decides on its own signals; an extension with `unlimitedStorage` is
 * usually granted without a prompt, but that is its choice, not a guarantee, so
 * a refusal is logged rather than treated as an error. Re-asking after a grant
 * is pointless, hence the `persisted()` check first.
 */
export async function ensurePersistentStorage(
  log: (...args: unknown[]) => void,
  warn: (...args: unknown[]) => void,
): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    const granted = await navigator.storage.persist();
    if (granted) log('Storage is persistent: retained recordings are exempt from eviction');
    else warn('Storage persistence was refused; retained recordings may be evicted under pressure');
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
