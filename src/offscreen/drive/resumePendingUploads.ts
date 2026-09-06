/**
 * @file offscreen/drive/resumePendingUploads.ts
 *
 * Recovers Drive uploads interrupted by a crash or power-off. Markers retain the
 * recording and job identities, allowing recovery to converge history and popup
 * state instead of silently uploading a file behind the background's back.
 */

import { readFileByKey, removeByKey } from '../storage/opfsLayout';
import type { UploadJob, UploadJobFile } from '../../shared/recording';
import { DriveTarget, type DriveUploadResult } from '../DriveTarget';
import { describeRuntimeError } from '../errors';
import { DRIVE_ROOT_FOLDER_NAME } from './constants';
import { DriveFolderResolver } from './DriveFolderResolver';
import { createCachedTokenProvider, type TokenProvider } from './request';
import type { PendingUpload, PendingUploadStore } from './PendingUploadStore';
import { isWebmRecordingFilename } from '../../shared/recordingFormats';

type RecoveredDriveFile = Pick<DriveUploadResult, 'id' | 'webViewLink' | 'driveFolderId' | 'driveFolderName' | 'folderWebViewLink'> | void;

export type ResumePendingUploadsDeps = {
  store: PendingUploadStore;
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  openOpfsFile: (opfsFilename: string) => Promise<Blob | null>;
  removeOpfsFile: (opfsFilename: string) => Promise<void>;
  fixDuration: (raw: Blob) => Promise<Blob>;
  uploadFile: (file: Blob, entry: PendingUpload) => Promise<RecoveredDriveFile>;
  /** Receives the initial and terminal state of every identity-bearing recovered job. */
  reportJob?: (job: UploadJob) => Promise<void> | void;
  now?: () => number;
};

type RecoveryOutcome =
  | { status: 'uploaded'; bytes: number; driveFileId?: string; webViewLink?: string; driveFolderId?: string; driveFolderName?: string; folderWebViewLink?: string }
  | { status: 'retry-pending'; bytes?: number; error: string }
  | { status: 'unavailable'; error: string };

/** Re-uploads pending files and reports grouped job states when markers carry identity. */
export async function resumePendingDriveUploads(deps: ResumePendingUploadsDeps): Promise<void> {
  const pending = await deps.store.list();
  if (!pending.length) return;
  deps.log(`Recovering ${pending.length} interrupted Drive upload(s)`);

  const now = deps.now ?? Date.now;
  const groups = groupRecoverableJobs(pending, now());
  for (const group of groups.values()) await reportSafely(deps, group.job);

  const outcomes = new Map<string, RecoveryOutcome>();
  for (const entry of pending) {
    try {
      const raw = await deps.openOpfsFile(entry.opfsFilename);
      if (!raw || raw.size === 0) {
        outcomes.set(entry.opfsFilename, { status: 'unavailable', error: 'Recovery source is no longer available' });
        await deps.store.remove(entry.opfsFilename);
        continue;
      }
      const fixed = isWebmRecordingFilename(entry.filename) ? await deps.fixDuration(raw) : raw;
      const uploaded = await deps.uploadFile(fixed, entry);
      outcomes.set(entry.opfsFilename, {
        status: 'uploaded',
        bytes: fixed.size,
        ...(uploaded?.id ? { driveFileId: uploaded.id } : {}),
        ...(uploaded?.webViewLink ? { webViewLink: uploaded.webViewLink } : {}),
        ...(uploaded?.driveFolderId ? { driveFolderId: uploaded.driveFolderId } : {}),
        ...(uploaded?.driveFolderName ? { driveFolderName: uploaded.driveFolderName } : {}),
        ...(uploaded?.folderWebViewLink ? { folderWebViewLink: uploaded.folderWebViewLink } : {}),
      });
      await deps.store.remove(entry.opfsFilename);
      await deps.removeOpfsFile(entry.opfsFilename);
      deps.log('Recovered interrupted Drive upload', entry.filename);
    } catch (e) {
      const error = describeRuntimeError(e);
      outcomes.set(entry.opfsFilename, { status: 'retry-pending', error });
      deps.warn(
        'Could not recover interrupted upload; will retry next launch',
        entry.filename,
        error
      );
    }
  }

  for (const group of groups.values()) {
    const files = group.entries.map((entry) => toUploadJobFile(entry, outcomes.get(entry.opfsFilename)));
    const uploaded = files.filter((file) => file.status === 'uploaded').length;
    const recoveryPending = files.some((file) => file.status === 'retry-pending');
    const status: UploadJob['status'] = uploaded === files.length ? 'completed' : uploaded > 0 ? 'partial' : 'failed';
    const folder = [...outcomes.values()].find((outcome): outcome is Extract<RecoveryOutcome, { status: 'uploaded' }> => outcome.status === 'uploaded' && !!outcome.driveFolderId);
    await reportSafely(deps, {
      ...group.job,
      status,
      progress: 1,
      files,
      ...(folder?.driveFolderId ? { driveFolderId: folder.driveFolderId } : {}),
      ...(folder?.driveFolderName ? { driveFolderName: folder.driveFolderName } : {}),
      ...(folder?.folderWebViewLink ? { folderWebViewLink: folder.folderWebViewLink } : {}),
      ...(status === 'completed' ? { namingStatus: 'pending' as const } : {}),
      finishedAt: now(),
      ...(recoveryPending ? { recoveryPending: true as const } : {}),
    });
  }
}

function groupRecoverableJobs(pending: PendingUpload[], startedAt: number): Map<string, { entries: PendingUpload[]; job: UploadJob }> {
  const groups = new Map<string, { entries: PendingUpload[]; job: UploadJob }>();
  for (const entry of pending) {
    if (!entry.historyId || !entry.jobId) continue; // legacy marker: recover bytes without a history/job replay.
    const existing = groups.get(entry.jobId);
    if (existing) {
      existing.entries.push(entry);
      existing.job.files.push({ stream: entry.stream, filename: entry.filename, status: 'uploading' });
      continue;
    }
    groups.set(entry.jobId, {
      entries: [entry],
      job: {
        id: entry.jobId,
        historyId: entry.historyId,
        label: entry.recordingFolderName,
        driveFolderName: entry.recordingFolderName,
        status: 'uploading',
        progress: 0,
        files: [{ stream: entry.stream, filename: entry.filename, status: 'uploading' }],
        startedAt,
      },
    });
  }
  return groups;
}

function toUploadJobFile(entry: PendingUpload, outcome: RecoveryOutcome | undefined): UploadJobFile {
  if (!outcome || outcome.status === 'retry-pending') {
    return {
      stream: entry.stream,
      filename: entry.filename,
      status: 'retry-pending',
      error: outcome?.status === 'retry-pending' ? outcome.error : 'Recovery was interrupted before an outcome was recorded',
    };
  }
  if (outcome.status === 'unavailable') {
    return { stream: entry.stream, filename: entry.filename, status: 'unavailable', error: outcome.error };
  }
  return {
    stream: entry.stream,
    filename: entry.filename,
    status: 'uploaded',
    bytes: outcome.bytes,
    ...(outcome.driveFileId ? { driveFileId: outcome.driveFileId } : {}),
    ...(outcome.webViewLink ? { webViewLink: outcome.webViewLink } : {}),
  };
}

async function reportSafely(deps: ResumePendingUploadsDeps, job: UploadJob): Promise<void> {
  try {
    await deps.reportJob?.(job);
  } catch (error) {
    deps.warn('Could not report recovered upload state; will replay on reconnect', job.id, describeRuntimeError(error));
  }
}

/** Wires recovery to real OPFS, the duration fixer, Drive, and the upload-state reporter. */
export function resumePendingDriveUploadsWithChrome(opts: {
  store: PendingUploadStore;
  getDriveToken: TokenProvider;
  log: (...a: any[]) => void;
  warn: (...a: any[]) => void;
  reportJob?: (job: UploadJob) => Promise<void> | void;
}): Promise<void> {
  const getUploadToken = createCachedTokenProvider(opts.getDriveToken);
  const folderResolver = new DriveFolderResolver(getUploadToken);

  return resumePendingDriveUploads({
    store: opts.store,
    log: opts.log,
    warn: opts.warn,
    reportJob: opts.reportJob,
    // A marker holds the OPFS key that was current when it was written: a
    // `staging/...` path today, a bare root filename before ADR-0006. Key-based
    // resolution handles both without a migration pass.
    openOpfsFile: async (key) => readFileByKey(await navigator.storage.getDirectory(), key),
    removeOpfsFile: async (key) => removeByKey(await navigator.storage.getDirectory(), key),
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
      return await target.upload(file);
    },
  });
}
