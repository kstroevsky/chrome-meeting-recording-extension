/**
 * @file offscreen/RecordingFinalizer.ts
 *
 * Handles the persistence phase that starts only after capture has fully
 * stopped. In local mode it exposes the sealed artifacts to the background for
 * download. In Drive mode it uploads sealed OPFS files sequentially and falls
 * back to local download per-file if Drive fails.
 */

import type { RecordingStream, UploadSummary } from '../shared/protocol';
import { DriveTarget } from './DriveTarget';
import { DriveFolderResolver } from './drive/DriveFolderResolver';
import { DRIVE_ROOT_FOLDER_NAME } from './drive/constants';
import { inferDriveRecordingFolderName } from './drive/folderNaming';
import { createCachedTokenProvider, type TokenProvider } from './drive/request';
import { describeRuntimeError } from './errors';
import type { CompletedRecordingArtifact, SealedStorageFile } from './RecorderEngine';
import { PERF_FLAGS, logPerf, nowMs, roundMs } from '../shared/perf';

const STREAM_UPLOAD_ORDER: RecordingStream[] = ['tab', 'mic', 'selfVideo'];
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
};

export type FinalizeArtifactsOptions = {
  artifacts: CompletedRecordingArtifact[];
  storageMode: 'local' | 'drive';
};

/**
 * Keeps post-stop storage concerns out of offscreen.ts so the runtime entrypoint
 * only manages lifecycle and RPC.
 */
export class RecordingFinalizer {
  constructor(private readonly deps: RecordingFinalizerDeps) {}

  async finalize(options: FinalizeArtifactsOptions): Promise<UploadSummary | undefined> {
    const orderedArtifacts = this.sortArtifacts(options.artifacts);
    if (!orderedArtifacts.length) return undefined;

    if (options.storageMode === 'drive') {
      const recordingFolderName = inferDriveRecordingFolderName(orderedArtifacts[0].artifact.filename);
      return await this.uploadArtifactsToDrive(orderedArtifacts, recordingFolderName);
    }

    for (const entry of orderedArtifacts) {
      this.saveArtifactLocally(entry.artifact);
    }
    return undefined;
  }

  private sortArtifacts(artifacts: CompletedRecordingArtifact[]): CompletedRecordingArtifact[] {
    return [...artifacts].sort(
      (a, b) => STREAM_UPLOAD_ORDER.indexOf(a.stream) - STREAM_UPLOAD_ORDER.indexOf(b.stream)
    );
  }

  private saveArtifactLocally(artifact: SealedStorageFile) {
    const blobUrl = URL.createObjectURL(artifact.file);
    this.deps.requestSave(artifact.filename, blobUrl, artifact.opfsFilename);
  }

  private async cleanupArtifact(artifact: SealedStorageFile) {
    try {
      await artifact.cleanup();
      if (artifact.opfsFilename) {
        this.deps.log('Cleaned up OPFS file', artifact.opfsFilename);
      }
    } catch (e) {
      this.deps.warn('Failed to cleanup artifact', artifact.filename, describeRuntimeError(e));
    }
  }

  private async uploadArtifactsToDrive(
    artifacts: CompletedRecordingArtifact[],
    recordingFolderName: string
  ): Promise<UploadSummary> {
    const sharedGetUploadToken = createCachedTokenProvider(this.deps.getDriveToken);
    const folderResolver = new DriveFolderResolver(sharedGetUploadToken);
    let sharedSetupError: string | null = null;
    try {
      await folderResolver.resolveUploadParentId({
        rootFolderName: DRIVE_ROOT_FOLDER_NAME,
        recordingFolderName,
      });
    } catch (e) {
      sharedSetupError = describeRuntimeError(e);
      this.deps.warn('Drive setup failed; all artifacts will fall back locally', sharedSetupError);
    }

    const summary: UploadSummary = {
      uploaded: [],
      localFallbacks: [],
    };

    const outcomes = await this.runWithConcurrency(
      artifacts,
      Math.min(PERF_FLAGS.parallelUploadConcurrency, 2),
      async ({ artifact, stream }) => {
        const startedAt = nowMs();

        if (sharedSetupError) {
          this.saveArtifactLocally(artifact);
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', {
            filename: artifact.filename,
            stream,
            uploaded: false,
            durationMs: roundMs(nowMs() - startedAt),
          });
          return {
            stream,
            filename: artifact.filename,
            uploaded: false,
            error: sharedSetupError,
          } satisfies UploadOutcome;
        }

        const driveTarget = new DriveTarget(
          artifact.filename,
          sharedGetUploadToken,
          (filename) => this.deps.log('Drive target complete:', filename),
          {
            rootFolderName: DRIVE_ROOT_FOLDER_NAME,
            recordingFolderName,
            shared: {
              getUploadToken: sharedGetUploadToken,
              folderResolver,
              log: this.deps.log,
            },
          }
        );

        try {
          await driveTarget.upload(artifact.file);
          await this.cleanupArtifact(artifact);
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', {
            filename: artifact.filename,
            stream,
            uploaded: true,
            durationMs: roundMs(nowMs() - startedAt),
          });
          return {
            stream,
            filename: artifact.filename,
            uploaded: true,
          } satisfies UploadOutcome;
        } catch (e) {
          const error = describeRuntimeError(e);
          this.deps.warn('Drive upload failed; falling back to local download', artifact.filename, error);
          this.saveArtifactLocally(artifact);
          logPerf(this.deps.log, 'finalizer', 'drive_file_complete', {
            filename: artifact.filename,
            stream,
            uploaded: false,
            durationMs: roundMs(nowMs() - startedAt),
          });
          return {
            stream,
            filename: artifact.filename,
            uploaded: false,
            error,
          } satisfies UploadOutcome;
        }
      }
    );

    for (const outcome of outcomes) {
      if (outcome.uploaded) {
        summary.uploaded.push({ stream: outcome.stream, filename: outcome.filename });
        continue;
      }
      summary.localFallbacks.push({
        stream: outcome.stream,
        filename: outcome.filename,
        error: outcome.error,
      });
    }

    logPerf(this.deps.log, 'finalizer', 'drive_finalize_complete', {
      artifactCount: artifacts.length,
      uploadedCount: summary.uploaded.length,
      localFallbackCount: summary.localFallbacks.length,
      fallbackRate:
        artifacts.length > 0 ? Math.round((summary.localFallbacks.length / artifacts.length) * 1000) / 1000 : 0,
      concurrency: Math.min(PERF_FLAGS.parallelUploadConcurrency, 2),
    });

    return summary;
  }

  private async runWithConcurrency<TItem, TResult>(
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
}
