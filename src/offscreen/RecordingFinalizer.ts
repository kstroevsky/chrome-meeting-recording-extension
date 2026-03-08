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
import { DRIVE_ROOT_FOLDER_NAME } from './drive/constants';
import { inferDriveRecordingFolderName } from './drive/folderNaming';
import type { TokenProvider } from './drive/request';
import { describeRuntimeError } from './errors';
import type { CompletedRecordingArtifact, SealedStorageFile } from './RecorderEngine';

const STREAM_UPLOAD_ORDER: RecordingStream[] = ['tab', 'mic', 'selfVideo'];

export type RecordingFinalizerDeps = {
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  requestSave: (filename: string, blobUrl: string, opfsFilename?: string) => void;
  getDriveToken: TokenProvider;
};

export type FinalizeArtifactsOptions = {
  artifacts: CompletedRecordingArtifact[];
  storageMode: 'local' | 'drive';
  driveRecordingFolderName?: string | null;
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
      const recordingFolderName =
        options.driveRecordingFolderName?.trim() ||
        inferDriveRecordingFolderName(orderedArtifacts[0].artifact.filename);
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
    const summary: UploadSummary = {
      uploaded: [],
      localFallbacks: [],
    };

    for (const entry of artifacts) {
      const { artifact, stream } = entry;
      const driveTarget = new DriveTarget(
        artifact.filename,
        this.deps.getDriveToken,
        (filename) => this.deps.log('Drive target complete:', filename),
        {
          rootFolderName: DRIVE_ROOT_FOLDER_NAME,
          recordingFolderName,
        }
      );

      try {
        await driveTarget.upload(artifact.file);
        summary.uploaded.push({ stream, filename: artifact.filename });
        await this.cleanupArtifact(artifact);
      } catch (e) {
        const error = describeRuntimeError(e);
        this.deps.warn('Drive upload failed; falling back to local download', artifact.filename, error);
        summary.localFallbacks.push({ stream, filename: artifact.filename, error });
        this.saveArtifactLocally(artifact);
      }
    }

    return summary;
  }
}
