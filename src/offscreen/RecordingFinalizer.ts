/**
 * @file offscreen/RecordingFinalizer.ts
 *
 * Handles the persistence phase that starts only after capture has fully
 * stopped. In local mode it exposes the sealed artifacts to the background for
 * download. In Drive mode it uploads sealed OPFS files in deterministic order,
 * with bounded concurrency, and falls back to local download per-file if Drive fails.
 */

import type { RecordingStream, UploadSummary } from '../shared/recording';
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
  uploaded: boolean;
  error?: string;
};

export type RecordingFinalizerDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  requestSave: (filename: string, blobUrl: string, opfsFilename?: string) => void;
  getDriveToken: TokenProvider;
  reportWarning?: (warning: string) => void;
  /**
   * Records "mid-upload to Drive" markers so an upload interrupted by a crash is
   * recovered on the next launch. Optional: absent in contexts that don't
   * persist (e.g. unit tests).
   */
  pendingUploads?: PendingUploadStore;
  /**
   * Live aggregate Drive-upload progress as a fraction in [0, 1] across all
   * artifacts, already throttled to whole-percent steps. Optional: absent in
   * contexts with no UI to drive (e.g. crash recovery, unit tests).
   */
  onUploadProgress?: (fraction: number) => void;
};

export type FinalizeArtifactsOptions = {
  artifacts: CompletedRecordingArtifact[];
  storageMode: 'local' | 'drive';
  /**
   * Per-call aggregate Drive-upload progress (fraction in [0, 1], throttled to
   * whole-percent steps). Lets a per-job caller (the UploadManager, ADR-0004) get
   * its own progress; falls back to the construction-time `onUploadProgress` dep.
   */
  onUploadProgress?: (fraction: number) => void;
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
      const summary = await this.uploadArtifactsToDrive(orderedArtifacts, recordingFolderName, options.onUploadProgress);
      logPerf(this.deps.log, 'finalizer', 'finalize_complete', {
        durationMs: roundMs(nowMs() - startedAt),
        artifactCount: orderedArtifacts.length,
        storageMode: options.storageMode,
      });
      return summary;
    }

    for (const entry of orderedArtifacts) {
      this.saveArtifactLocally(entry.artifact, entry.stream, 'local');
    }
    logPerf(this.deps.log, 'finalizer', 'finalize_complete', {
      durationMs: roundMs(nowMs() - startedAt),
      artifactCount: orderedArtifacts.length,
      storageMode: options.storageMode,
    });
    return undefined;
  }

  private sortArtifacts(artifacts: CompletedRecordingArtifact[]): CompletedRecordingArtifact[] {
    return [...artifacts].sort((a, b) => STREAM_UPLOAD_ORDER.indexOf(a.stream) - STREAM_UPLOAD_ORDER.indexOf(b.stream));
  }

  private saveArtifactLocally(
    artifact: SealedStorageFile,
    stream: RecordingStream,
    reason: 'local' | 'fallback'
  ) {
    const blobUrl = URL.createObjectURL(artifact.file);
    logPerf(this.deps.log, 'finalizer', 'local_save_requested', {
      filename: artifact.filename,
      artifactBytes: artifact.file.size,
      stream,
      reason,
    });
    this.deps.requestSave(artifact.filename, blobUrl, artifact.opfsFilename);
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
    onUploadProgress?: (fraction: number) => void
  ): Promise<UploadSummary> {
    const sharedGetUploadToken = createCachedTokenProvider(this.deps.getDriveToken);
    const folderResolver = new DriveFolderResolver(sharedGetUploadToken);
    let sharedSetupError: string | null = null;
    try {
      await folderResolver.resolveUploadParentId({ rootFolderName: DRIVE_ROOT_FOLDER_NAME, recordingFolderName });
    } catch (e) {
      sharedSetupError = describeRuntimeError(e);
      this.deps.warn('Drive setup failed; all artifacts will fall back locally', sharedSetupError);
    }

    // Aggregate per-file committed bytes into one overall fraction. A file that
    // falls back locally counts as fully "done" for progress purposes (it is no
    // longer uploading) so the ring still reaches 100% on a partial-fallback run.
    // The report is throttled to whole-percent steps so a many-chunk upload can't
    // flood the OFFSCREEN_STATE → persist → popup path with redundant updates.
    const progressSink = onUploadProgress ?? this.deps.onUploadProgress;
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

    const summary: UploadSummary = { uploaded: [], localFallbacks: [] };
    const outcomes = await runWithConcurrency(
      artifacts,
      Math.min(PERF_FLAGS.parallelUploadConcurrency, 2),
      async ({ artifact, stream }, index) => {
        const markFileDone = () => { loadedPerFile[index] = artifact.file.size; reportProgress(); };
        const startedAt = nowMs();
        if (sharedSetupError) {
          this.saveArtifactLocally(artifact, stream, 'fallback');
          markFileDone();
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', { filename: artifact.filename, stream, uploaded: false, durationMs: roundMs(nowMs() - startedAt) });
          return { stream, filename: artifact.filename, uploaded: false, error: sharedSetupError } satisfies UploadOutcome;
        }

        const driveTarget = new DriveTarget(artifact.filename, sharedGetUploadToken, (filename) => this.deps.log('Drive target complete:', filename), {
          rootFolderName: DRIVE_ROOT_FOLDER_NAME,
          recordingFolderName,
          shared: { getUploadToken: sharedGetUploadToken, folderResolver, log: this.deps.log },
          onProgress: (uploaded) => { loadedPerFile[index] = uploaded; reportProgress(); },
        });

        // Mark the upload as in-flight so a crash/power-off mid-upload is
        // recovered on the next launch. Only files that actually live in OPFS
        // can be recovered (a RAM-fallback artifact has nothing to re-read).
        const opfsFilename = artifact.opfsFilename;
        if (opfsFilename) {
          await this.deps.pendingUploads?.put({ opfsFilename, filename: artifact.filename, stream, recordingFolderName });
        }

        try {
          await driveTarget.upload(artifact.file);
          if (opfsFilename) await this.deps.pendingUploads?.remove(opfsFilename);
          await this.cleanupArtifact(artifact);
          markFileDone();
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', { filename: artifact.filename, stream, uploaded: true, durationMs: roundMs(nowMs() - startedAt) });
          return { stream, filename: artifact.filename, uploaded: true } satisfies UploadOutcome;
        } catch (e) {
          const error = describeRuntimeError(e);
          // Falling back to a local download saves the file and cleans up OPFS,
          // so there is nothing left to recover — drop the marker.
          if (opfsFilename) await this.deps.pendingUploads?.remove(opfsFilename);
          this.deps.warn('Drive upload failed; falling back to local download', artifact.filename, error);
          this.saveArtifactLocally(artifact, stream, 'fallback');
          markFileDone();
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', { filename: artifact.filename, stream, uploaded: false, durationMs: roundMs(nowMs() - startedAt) });
          return { stream, filename: artifact.filename, uploaded: false, error } satisfies UploadOutcome;
        }
      }
    );

    for (const outcome of outcomes) {
      if (outcome.uploaded) {
        summary.uploaded.push({ stream: outcome.stream, filename: outcome.filename });
      } else {
        summary.localFallbacks.push({ stream: outcome.stream, filename: outcome.filename, error: outcome.error });
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
