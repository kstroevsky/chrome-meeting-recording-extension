/**
 * @file background/drive/LibraryRepairs.ts
 *
 * Two narrow, one-off repairs to library entries, found by the library health
 * check, run from the service worker console. Each plans unless applied.
 *
 * - Durations: recordings imported from Drive, or saved before the duration was
 *   stored, show none. The health check reads it from each file's own WebM
 *   header (or its last timestamps); this writes those values, never
 *   overwriting one the recorder measured.
 * - Re-pointing a video: an entry whose "recording" file is not media (a notes
 *   export saved under the video's name) is pointed at the real video beside it
 *   in the same Drive folder. The entry itself — id, notes, description — stays.
 */

import { contentTypeForRecordingFilename } from '../../shared/recordingFormats';
import { readImportedRecordingFilename } from '../../shared/recordingFilename';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../../shared/recordingHistory';
import type { RecordingHistoryMutation } from '../library/history/RecordingHistoryRepository';
import { fetchDriveTokenWithFallback } from './driveAuth';

export type DriveFileMetadata = {
  id: string;
  name: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  trashed?: boolean;
};

export type LibraryRepairsDeps = {
  history: {
    listAllIncludingDeleted: () => Promise<RecordingHistoryEntry[]>;
    update: (id: string, mutate: RecordingHistoryMutation) => Promise<RecordingHistoryEntry | undefined>;
  };
  /** A Drive file as the extension sees it, or null when it cannot. */
  getDriveFile: (fileId: string) => Promise<DriveFileMetadata | null>;
  /** The files directly inside a Drive folder, as the extension sees them. */
  listDriveFolder: (folderId: string) => Promise<DriveFileMetadata[]>;
  log: (...args: unknown[]) => void;
};

/** Longest duration accepted: anything beyond is a misread, not a meeting. */
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const MEDIA_EXTENSION = /\.(?:webm|mp4|m4a)$/i;

export class LibraryRepairs {
  constructor(private readonly deps: LibraryRepairsDeps) {}

  async setDurations(
    durations: ReadonlyArray<{ id: string; durationMs: number }>,
    options: { apply?: boolean } = {},
  ): Promise<{ applied: boolean; set: Array<{ id: string; name: string; durationMs: number }>; skipped: Array<{ id: string; reason: string }> }> {
    const entries = new Map((await this.deps.history.listAllIncludingDeleted()).map((entry) => [entry.id, entry]));
    const set: Array<{ id: string; name: string; durationMs: number }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const { id, durationMs } of durations) {
      const entry = entries.get(id);
      if (!entry || entry.deletedAt) { skipped.push({ id, reason: 'not in the library' }); continue; }
      if (entry.durationMs != null) { skipped.push({ id, reason: 'already has a duration' }); continue; }
      if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) {
        skipped.push({ id, reason: `implausible duration ${durationMs}` });
        continue;
      }
      set.push({ id, name: entry.name, durationMs: Math.round(durationMs) });
    }
    if (!options.apply) return { applied: false, set, skipped };
    for (const item of set) {
      await this.deps.history.update(item.id, (current) => (
        current && !current.deletedAt && current.durationMs == null ? { ...current, durationMs: item.durationMs } : current
      ));
    }
    this.deps.log(`Set the duration of ${set.length} recording(s)`);
    return { applied: true, set, skipped };
  }

  /** `video` is the Drive file's id, or its name inside the recording's own folder. */
  async repointVideo(
    entryName: string,
    video: string,
    options: { apply?: boolean } = {},
  ): Promise<{ applied: boolean; entry: string; from: string; to: string }> {
    const all = await this.deps.history.listAllIncludingDeleted();
    const matches = all.filter((entry) => !entry.deletedAt && entry.name === entryName);
    if (matches.length !== 1) throw new Error(`Expected one library entry named "${entryName}", found ${matches.length}`);
    const [entry] = matches;
    const targets = entry.files.filter((file) => file.stream === 'tab' && !file.kind && MEDIA_EXTENSION.test(file.filename));
    if (targets.length !== 1) throw new Error(`Expected one recording file in "${entryName}", found ${targets.length}`);
    const [target] = targets;

    const byName = entry.driveFolderId
      ? (await this.deps.listDriveFolder(entry.driveFolderId)).filter((candidate) => candidate.name === video)
      : [];
    if (byName.length > 1) throw new Error(`More than one "${video}" in this recording's folder`);
    const driveFileId = byName[0]?.id ?? video;
    const found = await this.deps.getDriveFile(driveFileId);
    if (!found || found.trashed) throw new Error('The extension cannot read that Drive file, or it is in the trash');
    if (readImportedRecordingFilename(found.name)?.stream !== 'tab') throw new Error(`"${found.name}" is not a recording file`);
    if (entry.driveFolderId && !found.parents?.includes(entry.driveFolderId)) {
      throw new Error(`"${found.name}" is not in this recording's own Drive folder`);
    }
    const owner = all.find((other) => other.id !== entry.id && !other.deletedAt && other.files.some((file) =>
      file.driveFileId === driveFileId || file.locations.some((location) => location.kind === 'drive' && location.fileId === driveFileId)));
    if (owner) throw new Error(`"${found.name}" already belongs to "${owner.name}"`);

    const plan = { entry: entry.name, from: target.filename, to: found.name };
    if (!options.apply) return { applied: false, ...plan };
    await this.deps.history.update(entry.id, (current) => {
      if (!current || current.deletedAt) return current;
      return { ...current, files: current.files.map((file) => (file.id === target.id ? pointAt(file, found) : file)) };
    });
    this.deps.log(`Pointed "${entry.name}" at ${found.name}`);
    return { applied: true, ...plan };
  }
}

function pointAt(file: RecordingHistoryFile, video: DriveFileMetadata): RecordingHistoryFile {
  // Everything describing the old bytes goes; the file's id and stream stay.
  const { error: _error, downloadId: _download, bytes: _bytes, webViewLink: _link, ...rest } = file;
  const bytes = video.size != null && Number.isFinite(Number(video.size)) ? Number(video.size) : undefined;
  return {
    ...rest,
    filename: video.name,
    mimeType: contentTypeForRecordingFilename(video.name),
    locations: [{ kind: 'drive', fileId: video.id, ...(video.webViewLink ? { webViewLink: video.webViewLink } : {}) }],
    delivery: { requested: 'drive', status: 'uploaded' },
    destination: 'drive',
    status: 'available',
    ...(bytes != null ? { bytes } : {}),
    driveFileId: video.id,
    ...(video.webViewLink ? { webViewLink: video.webViewLink } : {}),
  };
}

/** A Drive file's metadata, read with the extension's own (narrow) permission. */
export async function fetchDriveFileMetadata(fileId: string): Promise<DriveFileMetadata | null> {
  const auth = await fetchDriveTokenWithFallback();
  if (!auth.ok) throw new Error(auth.error);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,parents,webViewLink,trashed`,
    { headers: { Authorization: `Bearer ${auth.token}` } },
  );
  return response.ok ? await response.json() : null;
}

/** The files directly inside a Drive folder, read with the extension's own permission. */
export async function listDriveFolderFiles(folderId: string): Promise<DriveFileMetadata[]> {
  const auth = await fetchDriveTokenWithFallback();
  if (!auth.ok) throw new Error(auth.error);
  const query = encodeURIComponent(`'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=1000&fields=files(id,name,size,parents,webViewLink,trashed)`,
    { headers: { Authorization: `Bearer ${auth.token}` } },
  );
  return response.ok ? ((await response.json()).files ?? []) : [];
}
