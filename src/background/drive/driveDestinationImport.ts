/**
 * @file background/drive/driveDestinationImport.ts
 *
 * Brings recordings that already sit in a destination's Drive folder into the
 * library, filed under that destination.
 *
 * The case it exists for: recordings organised by hand, or by older builds, into
 * `<root>/<destination>/<recording folder>/` that the library has never heard
 * of — or has heard of under a folder they no longer live in. Each recording
 * folder becomes one library entry pointing at the files by Drive id.
 *
 * Deliberately narrow, like the folder-name repair beside it. A folder is only
 * imported when every media file in it reads as a recording (old names
 * included) with at most one file per stream, and none of its files already
 * belongs to the library. A folder whose files belong to one live entry only
 * re-points that entry at the folder. Anything else — files a deleted entry
 * still claims, files split across entries, a folder it cannot read — is
 * reported and left alone: the user removed or arranged those on purpose.
 *
 * Pure, so what gets written is decided by something that can be read and
 * tested; the coordinator only lists Drive and applies the plan.
 */

import { readImportedRecordingFilename } from '../../shared/recordingFilename';
import { contentTypeForRecordingFilename } from '../../shared/recordingFormats';
import {
  recordingHistoryFileId,
  type RecordingHistoryEntry,
  type RecordingHistoryFile,
} from '../../shared/recordingHistory';
import type { RecordingStream } from '../../shared/recordingTypes';

export type DriveListedFile = { id: string; name: string; size?: string; webViewLink?: string };
export type DriveRecordingFolder = { id: string; name: string; files: DriveListedFile[] };

export type DestinationImportPlan = {
  /** New library entries, one per recording folder the library did not know. */
  create: RecordingHistoryEntry[];
  /** Live entries whose files were found in a different folder, or unfiled. */
  relink: { historyId: string; folderId: string; folderName: string }[];
  /** Folders left alone, and why. */
  skipped: { folder: string; reason: string }[];
  /**
   * Folders whose files belong to an entry the user removed — also in
   * `skipped`. A removal is a decision, so these are only ever offered back.
   */
  removed: { historyId: string; name: string; folderId: string; folderName: string }[];
};

const STREAM_ORDER: RecordingStream[] = ['tab', 'mic', 'self-video'];

export function driveFolderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

export function planDestinationImport(
  folders: readonly DriveRecordingFolder[],
  /** Every library entry, deleted ones included: a deletion is a decision. */
  entries: readonly RecordingHistoryEntry[],
  /** The destination's preset; absent for the default destination (unfiled). */
  presetId: string | undefined,
  newId: () => string,
): DestinationImportPlan {
  const plan: DestinationImportPlan = { create: [], relink: [], skipped: [], removed: [] };
  const ownerOf = new Map<string, RecordingHistoryEntry>();
  for (const entry of entries) {
    for (const file of entry.files) {
      const ids = [file.driveFileId, ...file.locations.flatMap((location) => location.kind === 'drive' ? [location.fileId] : [])];
      for (const id of ids) if (id) ownerOf.set(id, entry);
    }
  }

  for (const folder of folders) {
    // Sidecars (.vtt notes/transcripts) and anything unrecognised are not
    // media; they neither make nor block a recording.
    const media = folder.files.flatMap((file) => {
      const read = readImportedRecordingFilename(file.name);
      return read ? [{ file, ...read }] : [];
    });
    if (!media.length) {
      plan.skipped.push({ folder: folder.name, reason: 'no recording files' });
      continue;
    }
    if (new Set(media.map((item) => item.stream)).size !== media.length) {
      plan.skipped.push({ folder: folder.name, reason: 'more than one file per stream' });
      continue;
    }

    const owners = [...new Set(media.flatMap((item) => ownerOf.get(item.file.id) ?? []))];
    if (owners.length > 1) {
      plan.skipped.push({ folder: folder.name, reason: 'files belong to several library entries' });
      continue;
    }
    const [owner] = owners;
    if (owner?.deletedAt) {
      plan.skipped.push({ folder: folder.name, reason: 'removed from the library' });
      plan.removed.push({ historyId: owner.id, name: owner.name, folderId: folder.id, folderName: folder.name });
      continue;
    }
    if (owner) {
      if (owner.driveFolderId !== folder.id || owner.driveFolderPresetId !== presetId) {
        plan.relink.push({ historyId: owner.id, folderId: folder.id, folderName: folder.name });
      }
      continue;
    }

    const id = newId();
    // Named like a recording made today — after the meeting and the moment it
    // started (the tab recording's, when there is one) — not after the folder,
    // which older builds named after the upload.
    const lead = media.find((item) => item.stream === 'tab') ?? media[0];
    const files: RecordingHistoryFile[] = [...media]
      .sort((a, b) => STREAM_ORDER.indexOf(a.stream) - STREAM_ORDER.indexOf(b.stream))
      .map(({ file, stream }) => {
        const bytes = file.size != null && Number.isFinite(Number(file.size)) ? Number(file.size) : undefined;
        return {
          id: recordingHistoryFileId(id, stream),
          stream,
          filename: file.name,
          mimeType: contentTypeForRecordingFilename(file.name),
          locations: [{ kind: 'drive' as const, fileId: file.id, ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}) }],
          delivery: { requested: 'drive' as const, status: 'uploaded' as const },
          destination: 'drive' as const,
          status: 'available' as const,
          ...(bytes != null ? { bytes } : {}),
          driveFileId: file.id,
          ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
        };
      });
    plan.create.push({
      id,
      name: lead.label,
      createdAt: Math.min(...media.map((item) => item.startedAtMs)),
      storageMode: 'drive',
      status: 'complete',
      files,
      driveFolderId: folder.id,
      driveFolderName: folder.name,
      folderWebViewLink: driveFolderLink(folder.id),
      ...(presetId ? { driveFolderPresetId: presetId } : {}),
    });
  }
  return plan;
}

/**
 * A removed entry, brought back as it was — id, name, description — at the
 * folder its files are in now. Removal already deleted what it owned outside
 * Drive (notes, transcript, analysis, any local copy), so the local copies are
 * dropped rather than pointed at bytes that no longer exist.
 */
export function restoreDeletedEntry(
  entry: RecordingHistoryEntry,
  folder: { id: string; name: string },
  presetId: string | undefined,
): RecordingHistoryEntry {
  const { deletedAt: _deleted, cleanupPending: _cleanup, driveFolderPresetId: _preset, ...rest } = entry;
  return {
    ...rest,
    files: entry.files.map((file) => ({ ...file, locations: file.locations.filter((location) => location.kind !== 'opfs') })),
    driveFolderId: folder.id,
    driveFolderName: folder.name,
    folderWebViewLink: driveFolderLink(folder.id),
    ...(presetId ? { driveFolderPresetId: presetId } : {}),
  };
}

/** A live entry pointed at the folder its files are in now, filed by that folder's place. */
export function relinkedEntry(
  entry: RecordingHistoryEntry,
  folder: { id: string; name: string },
  presetId: string | undefined,
): RecordingHistoryEntry {
  // In the default destination, unfiled.
  const { driveFolderPresetId: _previous, ...rest } = entry;
  return {
    ...rest,
    driveFolderId: folder.id,
    driveFolderName: folder.name,
    folderWebViewLink: driveFolderLink(folder.id),
    ...(presetId ? { driveFolderPresetId: presetId } : {}),
  };
}
