/**
 * @file background/retainedStorage.ts
 *
 * How much disk the extension's own playback copies occupy (ADR-0006).
 *
 * Once OPFS stopped being scratch space and became a media library, quota went
 * from incidental to intentional. `"unlimitedStorage"` covers OPFS and exempts
 * extension storage from eviction, which makes the number here the extension's
 * responsibility rather than the browser's: nothing reclaims it automatically,
 * and deliberately so. Automatic age/size eviction is out of scope until the
 * product asks for it — silently deleting someone's recording is a worse
 * failure than running out of disk.
 */

import { listLibraryFiles, type DirectoryHandleLike } from '../offscreen/storage/opfsLayout';

export type RetainedStorageUsage = {
  /** Bytes held by extension-owned playback copies. */
  retainedBytes: number;
  /** How many retained files that is. */
  retainedFiles: number;
  /** Whole-origin usage, when the browser reports it. */
  usageBytes?: number;
  quotaBytes?: number;
};

type StorageEstimateLike = { usage?: number; quota?: number };

export async function measureRetainedStorage(
  root: DirectoryHandleLike,
  estimate?: () => Promise<StorageEstimateLike>,
): Promise<RetainedStorageUsage> {
  const files = await listLibraryFiles(root);
  const usage: RetainedStorageUsage = {
    retainedFiles: files.length,
    retainedBytes: files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0),
  };
  try {
    const reported = await estimate?.();
    if (typeof reported?.usage === 'number') usage.usageBytes = reported.usage;
    if (typeof reported?.quota === 'number') usage.quotaBytes = reported.quota;
  } catch {
    // Quota reporting is advisory; its absence must not fail the measurement.
  }
  return usage;
}
