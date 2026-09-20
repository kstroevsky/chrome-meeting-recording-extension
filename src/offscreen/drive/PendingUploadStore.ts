/**
 * @file offscreen/drive/PendingUploadStore.ts
 *
 * Persists "this sealed recording is mid-upload to Drive" markers so an upload
 * interrupted by a crash or power-off can be recovered on the next launch.
 *
 * One key per file (prefix-namespaced) — NOT a single map — so the
 * bounded-concurrency uploader's concurrent put/remove on different files can
 * never lose each other to a read-modify-write race.
 *
 * **Stored in IndexedDB, not `chrome.storage.local`.** This runs in the
 * offscreen document, whose `chrome` object exposes `runtime` and nothing else,
 * and the wrappers in `platform/chrome/storage.ts` degrade to a no-op rather
 * than throw so a failed marker cannot abort the stop/finalize pipeline. The
 * two together meant every marker written here was silently discarded — so no
 * interrupted upload was ever recoverable, while the code read as though it
 * were. IndexedDB belongs to the extension origin, which the offscreen
 * document can write and background can read.
 *
 * The marker deliberately does NOT store the resumable session URI: the on-disk
 * OPFS file is the raw, pre-duration-fix bytes, which don't match the bytes the
 * abandoned session already committed, so we recover by re-uploading fresh
 * rather than splicing onto the old session. The marker only needs enough to
 * re-run that upload.
 */

import { createIndexedDbKeyValueArea } from '../storage/indexedDbKeyValueArea';
import type { RecordingStream } from '../../shared/recordingTypes';

const PENDING_UPLOAD_PREFIX = 'pendingDriveUpload:';

export type PendingUpload = {
  opfsFilename: string;
  filename: string;
  stream: RecordingStream;
  recordingFolderName: string;
  /**
   * Where the interrupted upload was headed, so resuming it lands in the same
   * place rather than wherever today's settings point. Absent on markers
   * written before the root folder was a setting.
   */
  rootFolderName?: string;
  destinationFolderName?: string;
  /** Recording aggregate to reconcile after crash recovery; absent on legacy markers. */
  historyId?: string;
  /** Detached upload job to reconcile after crash recovery; absent on legacy markers. */
  jobId?: string;
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
    && (typeof (value as PendingUpload).rootFolderName === 'undefined' || typeof (value as PendingUpload).rootFolderName === 'string')
    && (typeof (value as PendingUpload).destinationFolderName === 'undefined' || typeof (value as PendingUpload).destinationFolderName === 'string')
    && (typeof (value as PendingUpload).historyId === 'undefined' || typeof (value as PendingUpload).historyId === 'string')
    && (typeof (value as PendingUpload).jobId === 'undefined' || typeof (value as PendingUpload).jobId === 'string')
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
export const PENDING_UPLOAD_DATABASE = 'pending-drive-uploads';

/** The store the offscreen document uses. */
export function createPendingUploadStore(): PendingUploadStore {
  return new PendingUploadStore(createIndexedDbKeyValueArea({
    databaseName: PENDING_UPLOAD_DATABASE,
    storeName: 'markers',
  }));
}
