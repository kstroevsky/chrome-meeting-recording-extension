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

/** ADR-0006: a logical artifact has replicas; delivery is a separate question. */
describe('artifact locations and delivery', () => {
  const entry = (files: unknown[], storageMode: 'local' | 'drive' = 'local') =>
    normalizeRecordingHistoryEntry({ id: 'r1', name: 'R', createdAt: 1, storageMode, files });
  const file = (overrides: Record<string, unknown>, storageMode: 'local' | 'drive' = 'local') =>
    entry([{ id: 'r1:tab', stream: 'tab', filename: 'r.webm', destination: 'local', status: 'available', ...overrides }], storageMode)?.files[0];

  describe('legacy rows, which carry no locations', () => {
    it('synthesizes a download replica and a plain downloaded delivery', () => {
      expect(file({ downloadId: 7 })).toMatchObject({
        locations: [{ kind: 'download', downloadId: 7 }],
        delivery: { requested: 'local', status: 'downloaded' },
      });
    });

    it('synthesizes a drive replica, carrying the view link when present', () => {
      expect(file({ destination: 'drive', driveFileId: 'd1', webViewLink: 'https://drive.example/d1' }, 'drive')).toMatchObject({
        locations: [{ kind: 'drive', fileId: 'd1', webViewLink: 'https://drive.example/d1' }],
        delivery: { requested: 'drive', status: 'uploaded' },
      });
    });

    it('recovers local-fallback — the outcome the single-destination shape could not express', () => {
      // Drive was requested, the bytes landed in Downloads, and the legacy row
      // recorded only where they landed.
      expect(file({ downloadId: 7 }, 'drive')).toMatchObject({
        locations: [{ kind: 'download', downloadId: 7 }],
        delivery: { requested: 'drive', status: 'local-fallback' },
      });
    });

    it('reports both replicas when Drive succeeded and a local copy also exists', () => {
      expect(file({ destination: 'drive', driveFileId: 'd1', downloadId: 7 }, 'drive')?.locations).toEqual([
        { kind: 'download', downloadId: 7 },
        { kind: 'drive', fileId: 'd1' },
      ]);
    });

    it('maps pending and unavailable onto pending and failed, keeping the error', () => {
      expect(file({ status: 'pending' })?.delivery).toEqual({ requested: 'local', status: 'pending' });
      expect(file({ status: 'unavailable', error: 'Download interrupted' })?.delivery).toEqual({
        requested: 'local', status: 'failed', error: 'Download interrupted',
      });
    });

    it('derives mimeType from the filename, including the notes sidecar', () => {
      expect(file({ filename: 'r.webm' })?.mimeType).toBe('video/webm');
      expect(file({ filename: 'r.mp4' })?.mimeType).toBe('video/mp4');
      expect(file({ filename: 'r.m4a' })?.mimeType).toBe('audio/mp4');
      expect(file({ filename: 'r.vtt', kind: 'notes' })?.mimeType).toBe('text/vtt');
    });
  });

  describe('rows already written in the new shape', () => {
    it('keeps stored locations, delivery and mimeType verbatim', () => {
      expect(file({
        mimeType: 'video/mp4',
        locations: [{ kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 99 }],
        delivery: { requested: 'drive', status: 'local-fallback', error: 'Drive quota' },
        downloadId: 7,
      })).toMatchObject({
        mimeType: 'video/mp4',
        locations: [{ kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 99 }],
        delivery: { requested: 'drive', status: 'local-fallback', error: 'Drive quota' },
      });
    });

    it('does not resurrect a replica the owner deliberately removed', () => {
      // An empty list is a real state — retention deleted the OPFS copy — so it
      // must not be re-synthesized from the legacy fields that still linger.
      expect(file({ locations: [], downloadId: 7, driveFileId: 'd1' })?.locations).toEqual([]);
    });

    it('drops malformed location entries without discarding the row', () => {
      expect(file({
        locations: [
          { kind: 'download', downloadId: 1.5 },
          { kind: 'opfs', key: '   ' },
          { kind: 'drive' },
          { kind: 'elsewhere', key: 'x' },
          { kind: 'download', downloadId: 7 },
        ],
      })?.locations).toEqual([{ kind: 'download', downloadId: 7 }]);
    });

    it('keeps a negative timelineOffsetMs, which means the track started before the master', () => {
      expect(file({ timelineOffsetMs: -120 })?.timelineOffsetMs).toBe(-120);
      expect(file({ timelineOffsetMs: 0 })?.timelineOffsetMs).toBe(0);
      expect(file({ timelineOffsetMs: Number.NaN })?.timelineOffsetMs).toBeUndefined();
      expect(file({})?.timelineOffsetMs).toBeUndefined();
    });
  });
});

/**
 * The corruption that cost a user an hour of microphone audio: a notes sidecar
 * stored under the mic row's id, so history held two rows called `…:mic`.
 */
describe('two rows sharing an id', () => {
  const entryWith = (files: unknown[]) => normalizeRecordingHistoryEntry({
    id: 'r1', name: 'R', createdAt: 1, storageMode: 'drive', files,
  });
  const row = (over: Record<string, unknown>) => ({
    id: 'r1:mic', stream: 'mic', filename: 'a-mic.webm',
    destination: 'drive', status: 'available', ...over,
  });

  it('keeps the real media and drops the sidecar wearing its id', () => {
    const entry = entryWith([
      row({ bytes: 86, mimeType: 'text/vtt', kind: 'notes' }),
      row({ bytes: 44_911_708, mimeType: 'audio/webm' }),
    ]);
    expect(entry!.files).toHaveLength(1);
    expect(entry!.files[0].bytes).toBe(44_911_708);
    expect(entry!.files[0].kind).toBeUndefined();
  });

  it('resolves in the same way whichever order they were stored', () => {
    const entry = entryWith([
      row({ bytes: 44_911_708, mimeType: 'audio/webm' }),
      row({ bytes: 86, mimeType: 'text/vtt', kind: 'notes' }),
    ]);
    expect(entry!.files).toHaveLength(1);
    expect(entry!.files[0].bytes).toBe(44_911_708);
  });

  it('keeps the sidecar when the id says it is one', () => {
    const entry = entryWith([
      { ...row({ bytes: 400, mimeType: 'audio/webm' }), id: 'r1:notes' },
      { ...row({ bytes: 86, mimeType: 'text/vtt', kind: 'notes' }), id: 'r1:notes' },
    ]);
    expect(entry!.files).toHaveLength(1);
    expect(entry!.files[0].kind).toBe('notes');
  });

  it('falls back to the larger file when neither row matches its id', () => {
    const entry = entryWith([row({ bytes: 10 }), row({ bytes: 5_000 })]);
    expect(entry!.files).toHaveLength(1);
    expect(entry!.files[0].bytes).toBe(5_000);
  });

  it('leaves distinct ids alone', () => {
    const entry = entryWith([
      row({ bytes: 1 }),
      { ...row({ bytes: 2 }), id: 'r1:tab', stream: 'tab', filename: 'a.webm' },
    ]);
    expect(entry!.files.map((f) => f.id)).toEqual(['r1:mic', 'r1:tab']);
  });
});

