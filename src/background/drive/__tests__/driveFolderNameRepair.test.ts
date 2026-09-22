/**
 * These renames happen in someone's Drive, so the planning is pure and tested:
 * what it declines to touch matters more than what it fixes.
 */
import { plannedFolderRenames } from '../driveFolderNameRepair';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';

// A filename the builder really writes: `{slug}-{stamp}-{type}.{ext}`.
const FILENAME = 'meet-team-sync-20260711T143045-recording.webm';

const entry = (over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
  id: 'rec-1',
  name: 'Team sync',
  createdAt: 1,
  status: 'completed',
  destination: 'drive',
  driveFolderId: 'folder-1',
  driveFolderName: 'google-meet-20260711T1430',
  files: [{
    id: 'f1', filename: FILENAME, stream: 'tab', destination: 'drive',
    status: 'completed', locations: [], delivery: { status: 'delivered' },
  }],
  ...over,
} as unknown as RecordingHistoryEntry);

describe('repairing folders named after the upload instead of the meeting', () => {
  it('renames a folder that still carries the fallback', () => {
    expect(plannedFolderRenames([entry()])).toEqual([{
      folderId: 'folder-1',
      historyId: 'rec-1',
      from: 'google-meet-20260711T1430',
      to: 'meet-team-sync-20260711T143045',
    }]);
  });

  it('leaves a folder the user has already named alone', () => {
    expect(plannedFolderRenames([entry({ driveFolderName: 'Team sync — Jul 11' })])).toEqual([]);
  });

  it('touches each folder once, however many files the recording has', () => {
    const shared = entry({
      files: [
        { id: 'f1', filename: FILENAME, stream: 'tab' },
        { id: 'f2', filename: 'meet-team-sync-20260711T143045-mic.webm', stream: 'mic' },
      ] as unknown as RecordingHistoryEntry['files'],
    });
    expect(plannedFolderRenames([shared, entry({ id: 'rec-2' })])).toHaveLength(1);
  });

  it('skips a recording whose filename it cannot read', () => {
    const odd = entry({
      files: [{ id: 'f1', filename: 'holiday-video.webm', stream: 'tab' }] as unknown as RecordingHistoryEntry['files'],
    });
    expect(plannedFolderRenames([odd])).toEqual([]);
  });

  it('skips a deleted recording, and one with no folder to rename', () => {
    expect(plannedFolderRenames([entry({ deletedAt: 2 } as Partial<RecordingHistoryEntry>)])).toEqual([]);
    expect(plannedFolderRenames([entry({ driveFolderId: undefined })])).toEqual([]);
    expect(plannedFolderRenames([entry({ driveFolderName: undefined })])).toEqual([]);
  });

  it('never renames a sidecar-named folder, because sidecars are not the recording', () => {
    const notesOnly = entry({
      files: [{
        id: 'f1', filename: 'meet-team-sync-20260711T143045-recording.vtt',
        stream: 'tab', kind: 'notes',
      }] as unknown as RecordingHistoryEntry['files'],
    });
    expect(plannedFolderRenames([notesOnly])).toEqual([]);
  });
});
