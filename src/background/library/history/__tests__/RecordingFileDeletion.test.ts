/**
 * Deleting files is the one irreversible thing here (Downloads), so what it
 * leaves alone matters as much as what it deletes: never a folder, because a
 * folder may hold files the extension cannot see, and trashing a folder
 * trashes everything in it.
 */
import { deleteRecordingFiles, type RecordingFileDeletionDeps } from '../RecordingFileDeletion';
import type { RecordingHistoryEntry } from '../../../../shared/recordingHistory';

function fakes() {
  const trashed: string[] = [];
  const removedDownloads: number[] = [];
  const failing = new Set<string>();
  const deps: RecordingFileDeletionDeps = {
    trashDriveFile: async (id) => {
      if (failing.has(id)) throw new Error('Google Drive answered 500');
      trashed.push(id);
    },
    removeDownload: async (id) => { removedDownloads.push(id); },
  };
  return { deps, trashed, removedDownloads, failing };
}

const entry = (over: Partial<RecordingHistoryEntry>): RecordingHistoryEntry => ({
  id: 'r', name: 'r', createdAt: 1, storageMode: 'drive', status: 'complete', files: [], ...over,
});
const driveFile = (id: string, driveFileId: string) => ({
  id, stream: 'tab' as const, filename: `${driveFileId}.webm`, mimeType: 'video/webm',
  locations: [{ kind: 'drive' as const, fileId: driveFileId }], delivery: { requested: 'drive' as const, status: 'uploaded' as const },
  destination: 'drive' as const, status: 'available' as const, driveFileId,
});

describe('deleting a removed recording’s files', () => {
  it('trashes its Drive files and never its folder', async () => {
    const { deps, trashed } = fakes();
    const result = await deleteRecordingFiles(entry({
      driveFolderId: 'recording-folder',
      files: [driveFile('a', 'f1'), driveFile('b', 'f2')],
    }), deps);
    expect(trashed).toEqual(['f1', 'f2']);
    expect(trashed).not.toContain('recording-folder');
    expect(result).toEqual({ deleted: 2, errors: [] });
  });

  it('deletes Downloads files', async () => {
    const { deps, removedDownloads, trashed } = fakes();
    const local = { ...driveFile('a', 'x'), driveFileId: undefined, locations: [], destination: 'local' as const, downloadId: 3626 };
    await deleteRecordingFiles(entry({ storageMode: 'local', files: [local] }), deps);
    expect(removedDownloads).toEqual([3626]);
    expect(trashed).toEqual([]);
  });

  it('deletes each copy once, even when two fields name it', async () => {
    const { deps, trashed, removedDownloads } = fakes();
    const both = { ...driveFile('a', 'f1'), downloadId: 7, locations: [{ kind: 'drive' as const, fileId: 'f1' }, { kind: 'download' as const, downloadId: 7 }] };
    await deleteRecordingFiles(entry({ files: [both] }), deps);
    expect(trashed).toEqual(['f1']);
    expect(removedDownloads).toEqual([7]);
  });

  it('keeps going past a failure and reports it', async () => {
    const { deps, trashed, failing } = fakes();
    failing.add('f1');
    const result = await deleteRecordingFiles(entry({ files: [driveFile('a', 'f1'), driveFile('b', 'f2')] }), deps);
    expect(trashed).toEqual(['f2']);
    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual(['Drive file f1.webm: Google Drive answered 500']);
  });
});
