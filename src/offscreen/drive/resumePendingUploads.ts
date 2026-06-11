/**
 * @file offscreen/drive/resumePendingUploads.ts
 *
 * Recovers Drive uploads interrupted by a crash or power-off. On the next
 * offscreen launch, each leftover marker (see PendingUploadStore) is re-uploaded
 * FRESH: we re-open the raw OPFS file, re-run the duration fix to reproduce the
 * deliverable bytes, and upload it through a brand-new resumable session.
 *
 * We deliberately do NOT resume the abandoned session from its committed offset:
 * the on-disk OPFS bytes are the raw, pre-duration-fix recording, so splicing
 * them onto a prefix of the duration-fixed file the old session committed would
 * silently corrupt the upload. Re-uploading fresh re-sends already-committed
 * bytes (only in the rare crash case) in exchange for guaranteed correctness.
 */

import { DriveTarget } from '../DriveTarget';
import { describeRuntimeError } from '../errors';
import { DRIVE_ROOT_FOLDER_NAME } from './constants';
import { DriveFolderResolver } from './DriveFolderResolver';
import { createCachedTokenProvider, type TokenProvider } from './request';
import type { PendingUpload, PendingUploadStore } from './PendingUploadStore';

export type ResumePendingUploadsDeps = {
  store: PendingUploadStore;
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  /** Reads the raw OPFS file for a marker, or null when it no longer exists. */
  openOpfsFile: (opfsFilename: string) => Promise<Blob | null>;
  /** Deletes the OPFS file after a successful recovery upload. */
  removeOpfsFile: (opfsFilename: string) => Promise<void>;
  /** Reconstructs the duration-fixed deliverable bytes from the raw OPFS file. */
  fixDuration: (raw: Blob) => Promise<Blob>;
  /** Uploads the fixed file fresh to Drive (new resumable session). */
  uploadFile: (file: Blob, entry: PendingUpload) => Promise<void>;
};

/**
 * Re-uploads every recording whose Drive upload was interrupted. A marker whose
 * OPFS file is gone (e.g. it was already saved locally) is simply dropped. An
 * upload failure leaves the marker in place for a future attempt.
 */
export async function resumePendingDriveUploads(deps: ResumePendingUploadsDeps): Promise<void> {
  const pending = await deps.store.list();
  if (!pending.length) return;
  deps.log(`Recovering ${pending.length} interrupted Drive upload(s)`);

  for (const entry of pending) {
    try {
      const raw = await deps.openOpfsFile(entry.opfsFilename);
      if (!raw || raw.size === 0) {
        await deps.store.remove(entry.opfsFilename);
        continue;
      }
      const fixed = await deps.fixDuration(raw);
      await deps.uploadFile(fixed, entry);
      // Clear the marker the instant the upload is confirmed so the (already
      // tiny) "crash between Drive's 200 and our cleanup" duplicate window stays
      // as small as possible; then remove the now-redundant OPFS file.
      await deps.store.remove(entry.opfsFilename);
      await deps.removeOpfsFile(entry.opfsFilename);
      deps.log('Recovered interrupted Drive upload', entry.filename);
    } catch (e) {
      deps.warn(
        'Could not recover interrupted upload; will retry next launch',
        entry.filename,
        describeRuntimeError(e)
      );
    }
  }
}

/**
 * Wires `resumePendingDriveUploads` to the real OPFS, the dynamically-imported
 * duration fix (kept out of the offscreen bundle), and a fresh DriveTarget.
 */
export function resumePendingDriveUploadsWithChrome(opts: {
  store: PendingUploadStore;
  getDriveToken: TokenProvider;
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
}): Promise<void> {
  const getUploadToken = createCachedTokenProvider(opts.getDriveToken);
  const folderResolver = new DriveFolderResolver(getUploadToken);

  return resumePendingDriveUploads({
    store: opts.store,
    log: opts.log,
    warn: opts.warn,
    openOpfsFile: async (name) => {
      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(name);
        return await handle.getFile();
      } catch {
        return null;
      }
    },
    removeOpfsFile: async (name) => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(name);
      } catch {
        /* already gone */
      }
    },
    fixDuration: async (raw) => {
      const { default: fixWebmDuration } = await import('webm-duration-fix');
      return await fixWebmDuration(raw as File);
    },
    uploadFile: async (file, entry) => {
      const target = new DriveTarget(entry.filename, opts.getDriveToken, () => {}, {
        rootFolderName: DRIVE_ROOT_FOLDER_NAME,
        recordingFolderName: entry.recordingFolderName,
        shared: { getUploadToken, folderResolver, log: opts.log },
      });
      await target.upload(file);
    },
  });
}
