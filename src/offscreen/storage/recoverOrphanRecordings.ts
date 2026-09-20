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
import { recordingStreamOf } from '../../shared/recordingFilename';
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

/**
 * Recover at most this many orphans per launch, unattended; the rest drain on
 * later launches.
 *
 * Deliberately small. For three months the filename pattern this scan filters
 * on did not match the names the recorder produced, so every orphan was
 * invisible and none were ever recovered — a backlog may exist that nobody has
 * been told about. Draining it twenty-five at a time would drop an armful of
 * video into someone's Downloads folder with no explanation. The popup offers
 * them back one at a time instead (8D), with a name and a choice; this path is
 * only the backstop for a question never answered.
 */
const MAX_ORPHANS_PER_RUN = 3;
/**
 * How long an orphan is left for the user to decide about (design 8D) before
 * it is recovered without asking.
 *
 * Asking is better than guessing — it is their recording, and the design offers
 * a name, a destination and a discard. But a question nobody answers must not
 * become bytes nobody reclaims, so after a week the old behaviour takes over
 * and downloads it. Silence then costs a file in Downloads, not a lost meeting.
 */
export const ORPHAN_DECISION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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
  /**
   * Orphans newer than this are left alone: the user is being asked about them
   * (8D). Omitted recovers everything, which is what a caller with no popup to
   * ask through wants.
   */
  decisionWindowMs?: number;
};

/**
 * What listing needs, which is less than recovering: no sealing, no saving, no
 * deleting — only enough to say what is there and how big it is.
 */
export type OrphanListingDeps = Pick<OrphanRecoveryDeps, 'cutoffMs' | 'listOrphanCandidates' | 'excludedNames'> & {
  /** Size of an OPFS file in bytes, or 0 when it is gone. */
  fileSize: (key: OpfsKey) => Promise<number>;
};

/** One unsaved recording, as the popup needs to describe it (8D). */
export type UnsavedRecording = {
  key: OpfsKey;
  filename: string;
  sizeBytes: number;
  lastModifiedMs: number;
};

/**
 * Lists what a crash left behind, without touching any of it.
 *
 * Side-effect free on purpose: this answers the popup's question, and the popup
 * asks before the user has decided anything. Sealing, downloading and deleting
 * all belong to the answer, not the question.
 */
export async function listOrphanRecordings(deps: OrphanListingDeps): Promise<UnsavedRecording[]> {
  const [candidates, excluded] = await Promise.all([
    deps.listOrphanCandidates(),
    deps.excludedNames(),
  ]);
  const orphans = candidates
    .filter((candidate) => candidate.lastModifiedMs < deps.cutoffMs && !excluded.has(candidate.key))
    .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs); // newest first: the one they just lost
  const out: UnsavedRecording[] = [];
  for (const candidate of orphans) {
    const sizeBytes = await deps.fileSize(candidate.key);
    // A zero-byte file is a capture that never wrote anything; there is nothing
    // to offer and nothing worth naming.
    if (sizeBytes > 0) out.push({ ...candidate, sizeBytes });
  }
  return out;
}

export async function recoverOrphanRecordings(deps: OrphanRecoveryDeps): Promise<void> {
  const [candidates, excluded] = await Promise.all([
    deps.listOrphanCandidates(),
    deps.excludedNames(),
  ]);
  // Recent ones are the user's to decide about; this path takes over only once
  // the question has gone unanswered long enough (8D).
  const undecidedBefore = deps.decisionWindowMs != null ? deps.cutoffMs - deps.decisionWindowMs : deps.cutoffMs;
  const orphans = candidates
    .filter((candidate) => candidate.lastModifiedMs < Math.min(deps.cutoffMs, undecidedBefore) && !excluded.has(candidate.key))
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
/**
 * The OPFS-facing half of both paths. Shared so that what the popup is offered
 * and what the recovery scan acts on can never disagree about which files are
 * candidates — a disagreement there would offer a recording that was already
 * downloaded, or hide one that was not.
 */
function opfsWiring(pendingUploads: PendingUploadStore) {
  return {
    listOrphanCandidates: async (): Promise<OrphanCandidate[]> => {
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
      new Set((await pendingUploads.list()).map((entry) => entry.opfsFilename)),
    fileSize: async (key: OpfsKey) =>
      (await readFileByKey(await navigator.storage.getDirectory(), key))?.size ?? 0,
  };
}

/** Lists what a crash left behind, wired to OPFS and the upload markers. */
export function listOrphanRecordingsWithChrome(
  cutoffMs: number,
  pendingUploads: PendingUploadStore,
): Promise<UnsavedRecording[]> {
  const wiring = opfsWiring(pendingUploads);
  return listOrphanRecordings({
    cutoffMs,
    listOrphanCandidates: wiring.listOrphanCandidates,
    excludedNames: wiring.excludedNames,
    fileSize: wiring.fileSize,
  });
}

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
    decisionWindowMs: ORPHAN_DECISION_WINDOW_MS,
    log: opts.log,
    warn: opts.warn,
    ...opfsWiring(opts.pendingUploads),
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
  return recordingStreamOf(filename);
}
