/**
 * @file offscreen/storage/recoverOrphanRecordings.ts
 *
 * Recovers recordings orphaned in OPFS by a crash or power-off DURING capture
 * (or during a local save) — the case the Drive upload-resume (#1) does not
 * cover, because those files were never sealed and never got an upload marker.
 *
 * On launch we scan OPFS for leftover recording files that have no pending-upload
 * marker (those are #1's job), seal each one best-effort (the duration fix on a
 * truncated file still yields a valid partial duration; on failure we deliver
 * the raw bytes), and hand it to the existing local-save flow. That flow
 * downloads the file and — only on download success — removes it from OPFS, so a
 * failed recovery is retried on the next launch and orphans never accumulate
 * silently.
 */

import { describeRuntimeError } from '../errors';
import { isRecordingFilename } from '../drive/folderNaming';
import type { PendingUploadStore } from '../drive/PendingUploadStore';

export type OrphanRecoveryDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  /** OPFS file names that look like recording artifacts. */
  listOrphanCandidates: () => Promise<string[]>;
  /** Names to skip because another path owns them (e.g. pending Drive uploads). */
  excludedNames: () => Promise<Set<string>>;
  /** Reads an OPFS file, or null when missing/unreadable. */
  openOpfsFile: (name: string) => Promise<Blob | null>;
  /** Best-effort duration fix; the wiring returns the raw bytes on failure. */
  sealFile: (raw: Blob) => Promise<Blob>;
  /** Hands a recovered file to the local-save flow (download + OPFS cleanup). */
  saveRecovered: (filename: string, file: Blob, opfsFilename: string) => void;
  /** Deletes an empty/missing OPFS file outright. */
  removeOpfsFile: (name: string) => Promise<void>;
};

export async function recoverOrphanRecordings(deps: OrphanRecoveryDeps): Promise<void> {
  const [candidates, excluded] = await Promise.all([
    deps.listOrphanCandidates(),
    deps.excludedNames(),
  ]);
  const orphans = candidates.filter((name) => !excluded.has(name));
  if (!orphans.length) return;
  deps.log(`Recovering ${orphans.length} orphaned recording file(s)`);

  for (const name of orphans) {
    try {
      const raw = await deps.openOpfsFile(name);
      if (!raw || raw.size === 0) {
        await deps.removeOpfsFile(name);
        continue;
      }
      const sealed = await deps.sealFile(raw);
      // Save flow downloads then (on success only) cleans up OPFS; a failed
      // download leaves the orphan in place for the next launch to retry.
      deps.saveRecovered(name, sealed, name);
      deps.log('Recovered orphaned recording', name);
    } catch (e) {
      deps.warn('Could not recover orphaned recording; will retry next launch', name, describeRuntimeError(e));
    }
  }
}

/**
 * Wires `recoverOrphanRecordings` to OPFS, the dynamically-imported duration fix
 * (kept out of the offscreen bundle), the pending-upload markers (to exclude
 * #1's files), and the offscreen's existing `requestSave` download path.
 */
export function recoverOrphanRecordingsWithChrome(opts: {
  pendingUploads: PendingUploadStore;
  requestSave: (filename: string, blobUrl: string, opfsFilename?: string) => void;
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
}): Promise<void> {
  return recoverOrphanRecordings({
    log: opts.log,
    warn: opts.warn,
    listOrphanCandidates: async () => {
      const names: string[] = [];
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (isRecordingFilename(name)) names.push(name);
        }
      } catch {
        /* OPFS unavailable */
      }
      return names;
    },
    excludedNames: async () =>
      new Set((await opts.pendingUploads.list()).map((entry) => entry.opfsFilename)),
    openOpfsFile: async (name) => {
      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(name);
        return await handle.getFile();
      } catch {
        return null;
      }
    },
    sealFile: async (raw) => {
      try {
        const { default: fixWebmDuration } = await import('webm-duration-fix');
        return await fixWebmDuration(raw as File);
      } catch {
        return raw; // best-effort: deliver the raw (possibly partial) file unsealed
      }
    },
    saveRecovered: (filename, file, opfsFilename) => {
      const blobUrl = URL.createObjectURL(file);
      opts.requestSave(filename, blobUrl, opfsFilename);
    },
    removeOpfsFile: async (name) => {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(name);
      } catch {
        /* already gone */
      }
    },
  });
}
