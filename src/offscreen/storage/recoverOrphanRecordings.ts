/**
 * @file offscreen/storage/recoverOrphanRecordings.ts
 *
 * Recovers recordings orphaned in OPFS by a crash or power-off DURING capture
 * (or during a local save) — the case the Drive upload-resume (#1) does not
 * cover, because those files were never sealed and never got an upload marker.
 *
 * On launch we scan OPFS for leftover recording files that (a) have no
 * pending-upload marker (those are #1's job) and (b) predate this offscreen
 * session — the cutoff. The cutoff is essential: the offscreen is created *for*
 * a new recording, so without it the scan would race with — and clobber — the
 * file that recording is actively writing. Files written by the current session
 * are newer than the startup cutoff and are skipped.
 *
 * Each surviving orphan is sealed best-effort (the duration fix on a truncated
 * file still yields a valid partial duration; on failure we deliver the raw
 * bytes) and handed to the existing local-save flow, which downloads it and —
 * only on download success — removes it from OPFS, so a failed recovery is
 * retried next launch and orphans never accumulate silently.
 */

import { describeRuntimeError } from '../errors';
import { isRecordingFilename } from '../drive/folderNaming';
import type { PendingUploadStore } from '../drive/PendingUploadStore';
import type { LocalSaveRequest } from '../RecordingFinalizer';
import type { RecordingStream } from '../../shared/recording';
import { isWebmRecordingFilename } from '../../shared/recordingFormats';
import { listFiles, readFileByKey, removeByKey, STAGING_DIR, type OpfsKey } from './opfsLayout';

/**
 * A recoverable file. `key` is its OPFS identity (ADR-0006) and `filename` the
 * display name; before the staging split these were the same string, which is
 * why they had to be pulled apart.
 */
export type OrphanCandidate = { key: OpfsKey; filename: string; lastModifiedMs: number };

/** Recover at most this many orphans per launch; the rest drain on later launches. */
const MAX_ORPHANS_PER_RUN = 25;
/** Above this size, deliver raw bytes rather than buffering the duration fix in RAM. */
const MAX_SEAL_IN_MEMORY_BYTES = 256 * 1024 * 1024;

export type OrphanRecoveryDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  /** Only recover files older than this (the offscreen session start time). */
  cutoffMs: number;
  /**
   * Cap on orphans handled per launch (a seatbelt against a pathological backlog).
   * Unbounded when omitted. Successful recovery deletes the file, so any remainder
   * drains over later launches — nothing is lost, just spread out.
   */
  maxPerRun?: number;
  /**
   * Above this size, skip the in-memory duration fix and deliver the raw bytes
   * instead (avoids OOM-ing the offscreen on a multi-GB file). Always seals when
   * omitted. The raw file is a complete, playable WebM whose duration metadata may
   * be unset until the first seek.
   */
  maxSealBytes?: number;
  /** OPFS recording files with their last-modified time. */
  listOrphanCandidates: () => Promise<OrphanCandidate[]>;
  /** OPFS keys to skip because another path owns them (e.g. pending Drive uploads). */
  excludedNames: () => Promise<Set<string>>;
  /** Reads an OPFS file by key, or null when missing/unreadable. */
  openOpfsFile: (key: OpfsKey) => Promise<Blob | null>;
  /** Best-effort duration fix; the wiring returns the raw bytes on failure. */
  sealFile: (raw: Blob) => Promise<Blob>;
  /** Hands a recovered file to the local-save flow (download + OPFS cleanup). */
  saveRecovered: (filename: string, file: Blob, opfsKey: OpfsKey) => void;
  /** Deletes an empty/missing OPFS file outright. */
  removeOpfsFile: (key: OpfsKey) => Promise<void>;
};

export async function recoverOrphanRecordings(deps: OrphanRecoveryDeps): Promise<void> {
  const [candidates, excluded] = await Promise.all([
    deps.listOrphanCandidates(),
    deps.excludedNames(),
  ]);
  const orphans = candidates
    .filter((candidate) => candidate.lastModifiedMs < deps.cutoffMs && !excluded.has(candidate.key))
    .sort((a, b) => a.lastModifiedMs - b.lastModifiedMs); // oldest (most likely abandoned) first
  if (!orphans.length) return;

  const batch = deps.maxPerRun != null ? orphans.slice(0, deps.maxPerRun) : orphans;
  const deferred = orphans.length - batch.length;
  deps.log(
    `Recovering ${batch.length} orphaned recording file(s)` +
      (deferred > 0 ? ` (${deferred} deferred to next launch)` : '')
  );

  for (const { key, filename } of batch) {
    try {
      const raw = await deps.openOpfsFile(key);
      if (!raw || raw.size === 0) {
        await deps.removeOpfsFile(key);
        continue;
      }
      // Skip the in-memory duration fix for oversized files — buffering a multi-GB
      // blob can OOM the offscreen. The raw, disk-backed bytes are still a complete,
      // playable WebM (the same best-effort fallback sealFile itself uses on error).
      const sealed = !isWebmRecordingFilename(filename)
        ? raw
        : deps.maxSealBytes != null && raw.size > deps.maxSealBytes ? raw : await deps.sealFile(raw);
      // Save flow downloads then (on success only) cleans up OPFS; a failed
      // download leaves the orphan in place for the next launch to retry.
      deps.saveRecovered(filename, sealed, key);
      deps.log('Recovered orphaned recording', key);
    } catch (e) {
      deps.warn('Could not recover orphaned recording; will retry next launch', key, describeRuntimeError(e));
    }
  }
}

/**
 * Wires `recoverOrphanRecordings` to OPFS, the dynamically-imported duration fix
 * (kept out of the offscreen bundle), the pending-upload markers (to exclude
 * #1's files), and the offscreen's existing `requestSave` download path.
 */
export function recoverOrphanRecordingsWithChrome(opts: {
  cutoffMs: number;
  pendingUploads: PendingUploadStore;
  requestSave: (request: LocalSaveRequest) => void;
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
}): Promise<void> {
  return recoverOrphanRecordings({
    cutoffMs: opts.cutoffMs,
    maxPerRun: MAX_ORPHANS_PER_RUN,
    maxSealBytes: MAX_SEAL_IN_MEMORY_BYTES,
    log: opts.log,
    warn: opts.warn,
    listOrphanCandidates: async () => {
      try {
        const root = await navigator.storage.getDirectory();
        // Two arms, and only two. `staging/` is where capture writes today. The
        // OPFS root is where it wrote before ADR-0006, so anything left there is
        // by definition a pre-split orphan — no version flag needed, and the arm
        // retires itself once the last one drains. `listFiles` never descends,
        // so `library/` is invisible here: recovery must never touch retained
        // media.
        const entries = [...await listFiles(root, STAGING_DIR), ...await listFiles(root, '')];
        return entries
          .filter((entry) => isRecordingFilename(entry.name))
          .map((entry) => ({ key: entry.key, filename: entry.name, lastModifiedMs: entry.lastModifiedMs }));
      } catch {
        return []; /* OPFS unavailable */
      }
    },
    excludedNames: async () =>
      new Set((await opts.pendingUploads.list()).map((entry) => entry.opfsFilename)),
    openOpfsFile: async (key) => readFileByKey(await navigator.storage.getDirectory(), key),
    sealFile: async (raw) => {
      try {
        const { default: fixWebmDuration } = await import('webm-duration-fix');
        return await fixWebmDuration(raw as File);
      } catch {
        return raw; // best-effort: deliver the raw (possibly partial) file unsealed
      }
    },
    saveRecovered: (filename, file, opfsKey) => {
      const blobUrl = URL.createObjectURL(file);
      opts.requestSave({
        stream: streamFromRecordingFilename(filename),
        filename,
        blobUrl,
        opfsFilename: opfsKey,
      });
    },
    removeOpfsFile: async (key) => removeByKey(await navigator.storage.getDirectory(), key),
  });
}

function streamFromRecordingFilename(filename: string): RecordingStream {
  if (/-mic\.(?:webm|m4a)$/.test(filename)) return 'mic';
  if (/-self-video\.(?:webm|mp4)$/.test(filename)) return 'self-video';
  return 'tab';
}
