import { isRecordingHistoryMessage, normalizeRecordingHistoryEntry } from '../recordingHistory';

describe('recording history durable-data boundaries', () => {
  it('normalizes valid durable rows and discards malformed files', () => {
    expect(normalizeRecordingHistoryEntry({
      id: ' recording:1 ',
      name: ' Standup ',
      note: '  Review decisions. ',
      durationMs: 61_000,
      driveFolderId: ' folder-1 ',
      driveFolderName: ' standup ',
      folderWebViewLink: ' https://drive.example/folder/1 ',
      createdAt: 1,
      storageMode: 'drive',
      files: [
        { id: 'recording:1:tab', stream: 'tab', filename: 'standup.webm', destination: 'drive', status: 'available', driveFileId: 'drive-1' },
        { id: 2, stream: 'tab' },
      ],
    })).toEqual({
      id: 'recording:1',
      name: 'Standup',
      note: 'Review decisions.',
      durationMs: 61_000,
      driveFolderId: 'folder-1',
      driveFolderName: 'standup',
      folderWebViewLink: 'https://drive.example/folder/1',
      createdAt: 1,
      storageMode: 'drive',
      status: 'complete',
      files: [{
        id: 'recording:1:tab',
        stream: 'tab',
        filename: 'standup.webm',
        mimeType: 'video/webm',
        locations: [{ kind: 'drive', fileId: 'drive-1' }],
        delivery: { requested: 'drive', status: 'uploaded' },
        destination: 'drive',
        status: 'available',
        driveFileId: 'drive-1',
      }],
    });
  });

  it('rejects invalid rows and malformed page cursors before they reach IndexedDB', () => {
    expect(normalizeRecordingHistoryEntry({ id: 'x', files: [] })).toBeUndefined();
    expect(isRecordingHistoryMessage({ type: 'LIST_RECORDING_HISTORY', cursor: { createdAt: 'now', id: 'x' } })).toBe(false);
    expect(isRecordingHistoryMessage({ type: 'LIST_RECORDING_HISTORY', cursor: { createdAt: 1, id: 'x' } })).toBe(true);
    expect(isRecordingHistoryMessage({ type: 'SET_RECORDING_HISTORY_NOTE', id: 'x', note: 'Follow up' })).toBe(true);
    expect(isRecordingHistoryMessage({ type: 'SET_RECORDING_HISTORY_NOTE', id: 'x', note: 1 })).toBe(false);
  });
});
