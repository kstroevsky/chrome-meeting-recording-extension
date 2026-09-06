/**
 * @file offscreen/RecordingFinalizer.ts
 *
 * Handles the persistence phase that starts only after capture has fully
 * stopped. In local mode it exposes the sealed artifacts to the background for
 * download. In Drive mode it uploads sealed OPFS files in deterministic order,
 * with bounded concurrency, and falls back to local download per-file if Drive fails.
 */

import type { RecordingArtifactContext, RecordingStream, UploadSummary } from '../shared/recording';
import { recordingHistoryFileId } from '../shared/recordingHistory';
import { DriveTarget } from './DriveTarget';
import { DriveFolderResolver } from './drive/DriveFolderResolver';
import { DRIVE_ROOT_FOLDER_NAME } from './drive/constants';
import { inferDriveRecordingFolderName } from './drive/folderNaming';
import { createCachedTokenProvider, type TokenProvider } from './drive/request';
import type { PendingUploadStore } from './drive/PendingUploadStore';
import { describeRuntimeError } from './errors';
import type { CompletedRecordingArtifact, SealedStorageFile } from './RecorderEngine';
import { PERF_FLAGS, logPerf, nowMs, roundMs } from '../shared/perf';

const STREAM_UPLOAD_ORDER: RecordingStream[] = ['tab', 'mic', 'self-video'];

type UploadOutcome = {
  stream: RecordingStream;
  filename: string;
  bytes: number;
  uploaded: boolean;
  driveFileId?: string;
  webViewLink?: string;
  error?: string;
};

function driveFolderWebViewLink(folderId: string | null): string | undefined {
  return folderId ? `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}` : undefined;
}

export type RecordingFinalizerDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  requestSave: (request: LocalSaveRequest) => void;
  getDriveToken: TokenProvider;
  reportWarning?: (warning: string) => void;
  /**
   * Records "mid-upload to Drive" markers so an upload interrupted by a crash is
   * recovered on the next launch. Optional: absent in contexts that don't
   * persist (e.g. unit tests).
   */
  pendingUploads?: PendingUploadStore;
  /**
   * Transfers a sealed staging artifact into the retained library before it is
   * handed to Downloads (ADR-0006). Optional: absent for contexts with no
   * history row to retain against, such as legacy orphan recovery.
   */
  retainedMedia?: {
    promote(stagingKey: string, recordingId: string, fileId: string, filename?: string): Promise<{ key: string; file: File }>;
  };
};

/** One local-download request with explicit artifact ownership. */
export type LocalSaveRequest = RecordingArtifactContext & {
  stream: RecordingStream;
  /** The notes sidecar rides a media stream, so `stream` alone cannot identify it. */
  kind?: 'notes';
  /**
   * Set once the artifact has been promoted into the retained library. Its
   * presence is what tells the delivery side these bytes are owned rather than
   * temporary — so a completed download records a replica instead of deleting
   * the source (ADR-0006).
   */
  retainedKey?: string;
  filename: string;
  /** Where this stream's recorder began, relative to the run (RecordingHistoryFile). */
  startOffsetMs?: number;
  blobUrl: string;
  opfsFilename?: string;
};

export type FinalizeArtifactsOptions = RecordingArtifactContext & {
  artifacts: CompletedRecordingArtifact[];
  storageMode: 'local' | 'drive';
  /**
   * Per-call aggregate Drive-upload progress (fraction in [0, 1], throttled to
   * whole-percent steps). Lets a per-job caller (the UploadManager, ADR-0004) get
   * its own progress; falls back to the construction-time `onUploadProgress` dep.
   */
  onUploadProgress?: (fraction: number) => void;
  /**
   * Suppresses the local-download failsafe when a Drive upload fails (ADR-0004). Set
   * for a *retry*: the file was already downloaded on the original failure, so failing
   * again should not drop a duplicate copy in Downloads. The file is still reported as
   * a fallback (not uploaded) — it just isn't re-saved.
   */
  skipLocalFallback?: boolean;
  /** Aborts Drive work; unfinished artifacts follow the normal local fallback path. */
  signal?: AbortSignal;
};

/** Runs async work with bounded concurrency while preserving input order in the results. */
async function runWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  work: (item: TItem, index: number) => Promise<TResult>
): Promise<TResult[]> {
  if (!items.length) return [];
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await work(items[currentIndex], currentIndex);
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Keeps post-stop storage concerns out of offscreen.ts so the runtime entrypoint
 * only manages lifecycle and RPC.
 */
export class RecordingFinalizer {
  constructor(private readonly deps: RecordingFinalizerDeps) {}

  /** Persists sealed artifacts locally or uploads them to Drive after recording stops. */
  async finalize(options: FinalizeArtifactsOptions): Promise<UploadSummary | undefined> {
    const startedAt = nowMs();
    const orderedArtifacts = this.sortArtifacts(options.artifacts);
    const context: RecordingArtifactContext = {
      historyId: options.historyId,
      uploadJobId: options.uploadJobId,
    };
    if (!orderedArtifacts.length) {
      logPerf(this.deps.log, 'finalizer', 'finalize_complete', {
        durationMs: roundMs(nowMs() - startedAt),
        artifactCount: 0,
        storageMode: options.storageMode,
      });
      return undefined;
    }

    if (options.storageMode === 'drive') {
      const recordingFolderName = inferDriveRecordingFolderName(orderedArtifacts[0].artifact.filename);
      const summary = await this.uploadArtifactsToDrive(
        orderedArtifacts,
        recordingFolderName,
        options.onUploadProgress,
        options.skipLocalFallback === true,
        options.signal,
        context
      );
      logPerf(this.deps.log, 'finalizer', 'finalize_complete', {
        durationMs: roundMs(nowMs() - startedAt),
        artifactCount: orderedArtifacts.length,
        storageMode: options.storageMode,
      });
      return summary;
    }

    for (const entry of orderedArtifacts) {
      await this.saveArtifactLocally(entry.artifact, entry.stream, 'local', context, entry.kind);
    }
    logPerf(this.deps.log, 'finalizer', 'finalize_complete', {
      durationMs: roundMs(nowMs() - startedAt),
      artifactCount: orderedArtifacts.length,
      storageMode: options.storageMode,
    });
    return undefined;
  }

  /**
   * Notes lead, then media in stream order. Uploading the sidecar first is the
   * point of it: a reader has the notes while the video is still going up
   * (ADR-0005), and it is bytes-cheap so it costs the media almost nothing.
   */
  private sortArtifacts(artifacts: CompletedRecordingArtifact[]): CompletedRecordingArtifact[] {
    const rank = (artifact: CompletedRecordingArtifact) =>
      artifact.kind === 'notes' ? -1 : STREAM_UPLOAD_ORDER.indexOf(artifact.stream);
    return [...artifacts].sort((a, b) => rank(a) - rank(b));
  }

  private async saveArtifactLocally(
    artifact: SealedStorageFile,
    stream: RecordingStream,
    reason: 'local' | 'fallback',
    context: RecordingArtifactContext,
    kind?: 'notes',
  ) {
    // Ownership transfers *before* delivery is attempted. That ordering is the
    // point: if the download then fails, the recording is still playable from
    // the library rather than being lost with the staging file.
    const retained = await this.promoteForRetention(artifact, stream, context, kind);
    // From the *retained* File: promotion moved the bytes, which invalidates the
    // File the sealed artifact is still holding.
    const blobUrl = URL.createObjectURL(retained?.file ?? artifact.file);
    const retainedKey = retained?.key;
    logPerf(this.deps.log, 'finalizer', 'local_save_requested', {
      filename: artifact.filename,
      artifactBytes: artifact.file.size,
      stream,
      reason,
    });
    this.deps.requestSave({
      ...(context.historyId ? { historyId: context.historyId } : {}),
      ...(context.uploadJobId ? { uploadJobId: context.uploadJobId } : {}),
      stream,
      ...(kind ? { kind } : {}),
      ...(retainedKey ? { retainedKey } : {}),
      filename: artifact.filename,
      ...(artifact.startOffsetMs != null ? { startOffsetMs: artifact.startOffsetMs } : {}),
      blobUrl,
      opfsFilename: artifact.opfsFilename,
    });
  }

  /**
   * Promotes a sealed staging artifact into the retained library. Best-effort:
   * a promotion failure must not cost the user the download, so it degrades to
   * the pre-ADR-0006 behaviour (deliver, then clean up staging) rather than
   * aborting delivery.
   */
  private async promoteForRetention(
    artifact: SealedStorageFile,
    stream: RecordingStream,
    context: RecordingArtifactContext,
    kind?: 'notes',
  ): Promise<{ key: string; file: File } | undefined> {
    const stagingKey = artifact.opfsFilename;
    // No history row means nothing owns the bytes long-term (legacy orphan
    // recovery), and a memory-backed artifact has no staging file to promote.
    if (!this.deps.retainedMedia || !context.historyId || !stagingKey) return undefined;
    try {
      const fileId = recordingHistoryFileId(context.historyId, stream, kind);
      const retained = await this.deps.retainedMedia.promote(stagingKey, context.historyId, fileId, artifact.filename);
      this.deps.log('Promoted to the retained library', retained.key);
      return retained;
    } catch (e) {
      this.deps.warn('Could not retain a playback copy; delivering without one', artifact.filename, describeRuntimeError(e));
      return undefined;
    }
  }

  private async cleanupArtifact(artifact: SealedStorageFile) {
    try {
      await artifact.cleanup();
      if (artifact.opfsFilename) this.deps.log('Cleaned up OPFS file', artifact.opfsFilename);
    } catch (e) {
      this.deps.warn('Failed to cleanup artifact', artifact.filename, describeRuntimeError(e));
    }
  }

  private async uploadArtifactsToDrive(
    artifacts: CompletedRecordingArtifact[],
    recordingFolderName: string,
    onUploadProgress?: (fraction: number) => void,
    skipLocalFallback = false,
    signal?: AbortSignal,
    context: RecordingArtifactContext = {},
  ): Promise<UploadSummary> {
    const sharedGetUploadToken = createCachedTokenProvider(this.deps.getDriveToken);
    const folderResolver = new DriveFolderResolver(sharedGetUploadToken);
    let folderId: string | null = null;
    let folderWebViewLink: string | undefined;
    let sharedSetupError: string | null = null;
    try {
      if (signal?.aborted) throw new DOMException('Upload canceled', 'AbortError');
      folderId = await folderResolver.resolveUploadParentId(
        { rootFolderName: DRIVE_ROOT_FOLDER_NAME, recordingFolderName },
        signal,
      );
      if (signal?.aborted) throw new DOMException('Upload canceled', 'AbortError');
      folderWebViewLink = driveFolderWebViewLink(folderId);
    } catch (e) {
      sharedSetupError = describeRuntimeError(e);
      this.deps.warn('Drive setup failed; all artifacts will fall back locally', sharedSetupError);
    }

    // Aggregate per-file committed bytes into one overall fraction. A file that
    // falls back locally counts as fully "done" for progress purposes (it is no
    // longer uploading) so the ring still reaches 100% on a partial-fallback run.
    // The report is throttled to whole-percent steps so a many-chunk upload can't
    // flood the OFFSCREEN_STATE → persist → popup path with redundant updates.
    const progressSink = onUploadProgress;
    const totalBytes = artifacts.reduce((sum, { artifact }) => sum + artifact.file.size, 0);
    const loadedPerFile = new Array<number>(artifacts.length).fill(0);
    let lastReportedPercent = -1;
    const reportProgress = () => {
      if (!progressSink || totalBytes === 0) return;
      const loaded = loadedPerFile.reduce((sum, n) => sum + n, 0);
      const percent = Math.min(100, Math.floor((loaded / totalBytes) * 100));
      if (percent <= lastReportedPercent) return;
      lastReportedPercent = percent;
      progressSink(loaded / totalBytes);
    };

    const summary: UploadSummary = {
      uploaded: [],
      localFallbacks: [],
      driveFolderName: recordingFolderName,
    };
    if (folderId) summary.driveFolderId = folderId;
    if (folderWebViewLink) summary.folderWebViewLink = folderWebViewLink;
    const outcomes = await runWithConcurrency(
      artifacts,
      Math.min(PERF_FLAGS.parallelUploadConcurrency, 2),
      async ({ artifact, stream, kind }, index) => {
        const markFileDone = () => { loadedPerFile[index] = artifact.file.size; reportProgress(); };
        const startedAt = nowMs();
        if (sharedSetupError) {
          if (!skipLocalFallback) await this.saveArtifactLocally(artifact, stream, 'fallback', context, kind);
          markFileDone();
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', { filename: artifact.filename, stream, uploaded: false, durationMs: roundMs(nowMs() - startedAt) });
          return { stream, filename: artifact.filename, bytes: artifact.file.size, uploaded: false, error: sharedSetupError } satisfies UploadOutcome;
        }

        const driveTarget = new DriveTarget(artifact.filename, sharedGetUploadToken, (filename) => this.deps.log('Drive target complete:', filename), {
          rootFolderName: DRIVE_ROOT_FOLDER_NAME,
          recordingFolderName,
          shared: { getUploadToken: sharedGetUploadToken, folderResolver, log: this.deps.log },
          onProgress: (uploaded) => { loadedPerFile[index] = uploaded; reportProgress(); },
          signal,
        });

        // Mark the upload as in-flight so a crash/power-off mid-upload is
        // recovered on the next launch. Only files that actually live in OPFS
        // can be recovered (a RAM-fallback artifact has nothing to re-read).
        const opfsFilename = artifact.opfsFilename;
        if (opfsFilename) {
          await this.deps.pendingUploads?.put({
            opfsFilename,
            filename: artifact.filename,
            stream,
            recordingFolderName,
            ...(context.historyId ? { historyId: context.historyId } : {}),
            ...(context.uploadJobId ? { jobId: context.uploadJobId } : {}),
          });
        }

        try {
          const uploadedFile = await driveTarget.upload(artifact.file);
          if (opfsFilename) await this.deps.pendingUploads?.remove(opfsFilename);
          await this.cleanupArtifact(artifact);
          markFileDone();
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', { filename: artifact.filename, stream, uploaded: true, durationMs: roundMs(nowMs() - startedAt) });
          return {
            stream,
            filename: artifact.filename,
            bytes: artifact.file.size,
            uploaded: true,
            driveFileId: uploadedFile?.id,
            webViewLink: uploadedFile?.webViewLink,
          } satisfies UploadOutcome;
        } catch (e) {
          const error = describeRuntimeError(e);
          // Falling back to a local download saves the file and cleans up OPFS,
          // so there is nothing left to recover — drop the marker. On a retry we skip
          // the download: the original failure already saved a local copy (ADR-0004).
          if (opfsFilename) await this.deps.pendingUploads?.remove(opfsFilename);
          if (skipLocalFallback) {
            this.deps.warn('Retry upload failed; keeping the existing local copy', artifact.filename, error);
          } else {
            this.deps.warn('Drive upload failed; falling back to local download', artifact.filename, error);
            await this.saveArtifactLocally(artifact, stream, 'fallback', context, kind);
          }
          markFileDone();
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', { filename: artifact.filename, stream, uploaded: false, durationMs: roundMs(nowMs() - startedAt) });
          return { stream, filename: artifact.filename, bytes: artifact.file.size, uploaded: false, error } satisfies UploadOutcome;
        }
      }
    );

    for (const outcome of outcomes) {
      if (outcome.uploaded) {
        const entry = {
          stream: outcome.stream,
          filename: outcome.filename,
          bytes: outcome.bytes,
        };
        if (outcome.driveFileId) Object.assign(entry, { driveFileId: outcome.driveFileId });
        if (outcome.webViewLink) Object.assign(entry, { webViewLink: outcome.webViewLink });
        summary.uploaded.push(entry);
      } else {
        summary.localFallbacks.push({ stream: outcome.stream, filename: outcome.filename, bytes: outcome.bytes, error: outcome.error });
      }
    }

    logPerf(this.deps.log, 'finalizer', 'drive_finalize_complete', {
      artifactCount: artifacts.length,
      uploadedCount: summary.uploaded.length,
      localFallbackCount: summary.localFallbacks.length,
      fallbackRate: artifacts.length > 0 ? Math.round((summary.localFallbacks.length / artifacts.length) * 1000) / 1000 : 0,
      concurrency: Math.min(PERF_FLAGS.parallelUploadConcurrency, 2),
    });

    return summary;
  }
}
