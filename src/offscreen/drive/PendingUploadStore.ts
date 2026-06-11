/**
 * @file offscreen/drive/PendingUploadStore.ts
 *
 * Persists "this sealed recording is mid-upload to Drive" markers so an upload
 * interrupted by a crash or power-off can be recovered on the next launch.
 *
 * One `chrome.storage.local` key per file (prefix-namespaced) — NOT a single
 * map — so the bounded-concurrency uploader's concurrent put/remove on
 * different files can never lose each other to a read-modify-write race.
 *
 * The marker deliberately does NOT store the resumable session URI: the on-disk
 * OPFS file is the raw, pre-duration-fix bytes, which don't match the bytes the
 * abandoned session already committed, so we recover by re-uploading fresh
 * rather than splicing onto the old session. The marker only needs enough to
 * re-run that upload.
 */

import {
  getAllLocalStorageValues,
  removeLocalStorageValues,
  setLocalStorageValues,
} from '../../platform/chrome/storage';
import type { RecordingStream } from '../../shared/recordingTypes';

const PENDING_UPLOAD_PREFIX = 'pendingDriveUpload:';

export type PendingUpload = {
  opfsFilename: string;
  filename: string;
  stream: RecordingStream;
  recordingFolderName: string;
};

export interface PendingUploadStorageArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function isPendingUpload(value: unknown): value is PendingUpload {
  return (
    !!value
    && typeof value === 'object'
    && typeof (value as PendingUpload).opfsFilename === 'string'
    && typeof (value as PendingUpload).filename === 'string'
    && typeof (value as PendingUpload).stream === 'string'
    && typeof (value as PendingUpload).recordingFolderName === 'string'
  );
}

export class PendingUploadStore {
  constructor(private readonly area: PendingUploadStorageArea) {}

  async put(entry: PendingUpload): Promise<void> {
    await this.area.set({ [PENDING_UPLOAD_PREFIX + entry.opfsFilename]: entry });
  }

  async remove(opfsFilename: string): Promise<void> {
    await this.area.remove(PENDING_UPLOAD_PREFIX + opfsFilename);
  }

  async list(): Promise<PendingUpload[]> {
    const all = await this.area.getAll();
    const out: PendingUpload[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(PENDING_UPLOAD_PREFIX) && isPendingUpload(value)) out.push(value);
    }
    return out;
  }
}

/** Builds a store backed by the real `chrome.storage.local` area. */
export function createChromePendingUploadStore(): PendingUploadStore {
  return new PendingUploadStore({
    getAll: () => getAllLocalStorageValues(),
    set: (items) => setLocalStorageValues(items),
    remove: (key) => removeLocalStorageValues(key),
  });
}
