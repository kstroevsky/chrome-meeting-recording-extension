/**
 * Both repairs rewrite what a library entry plays or says it lasts, so the
 * refusals are tested as carefully as the writes.
 */
import { LibraryRepairs, type DriveFileMetadata } from '../LibraryRepairs';
import { normalizeRecordingHistoryEntry, type RecordingHistoryEntry } from '../../../shared/recordingHistory';

const file = (id: string, filename: string, driveFileId: string, extra: Record<string, unknown> = {}) => ({
  id, stream: 'tab' as const, filename, mimeType: 'video/webm',
  locations: [{ kind: 'drive' as const, fileId: driveFileId }], delivery: { requested: 'drive' as const, status: 'uploaded' as const },
  destination: 'drive' as const, status: 'available' as const, driveFileId, bytes: 38, ...extra,
});
const entry = (id: string, name: string, over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
  id, name, createdAt: 1, storageMode: 'drive', status: 'complete', files: [], ...over,
});

function setup(rows: RecordingHistoryEntry[], driveFiles: Record<string, DriveFileMetadata> = {}) {
  const store = new Map(rows.map((row) => [row.id, row]));
  const history = {
    listAllIncludingDeleted: jest.fn(async () => [...store.values()]),
    update: jest.fn(async (id: string, mutate: (current: RecordingHistoryEntry | undefined) => RecordingHistoryEntry | undefined) => {
      const next = mutate(store.get(id));
      if (next) store.set(id, next);
      return next;
    }),
  };
  const repairs = new LibraryRepairs({
    history,
    getDriveFile: async (id) => driveFiles[id] ?? null,
    listDriveFolder: async (folderId) => Object.values(driveFiles).filter((f) => f.parents?.includes(folderId)),
    log: jest.fn(),
  });
  return { repairs, history, store };
}

describe('writing durations found by the health check', () => {
  it('sets missing durations only, and only when applied', async () => {
    const { repairs, history, store } = setup([
      entry('a', 'Therapy Apr 9'),
      entry('b', 'Measured', { durationMs: 60_000 }),
      entry('c', 'Removed', { deletedAt: 3 }),
    ]);
    const input = [
      { id: 'a', durationMs: 3_484_000.4 },
      { id: 'b', durationMs: 99_000 },
      { id: 'c', durationMs: 99_000 },
      { id: 'zz', durationMs: 99_000 },
      { id: 'a', durationMs: Number.NaN },
    ];

    const planned = await repairs.setDurations(input);
    expect(planned.set).toEqual([{ id: 'a', name: 'Therapy Apr 9', durationMs: 3_484_000 }]);
    expect(planned.skipped.map((s) => s.reason)).toEqual([
      'already has a duration', 'not in the library', 'not in the library', 'implausible duration NaN',
    ]);
    expect(history.update).not.toHaveBeenCalled();

    await repairs.setDurations(input, { apply: true });
    expect(store.get('a')?.durationMs).toBe(3_484_000);
    expect(store.get('b')?.durationMs).toBe(60_000);
  });

  it('refuses durations no meeting has', async () => {
    const { repairs } = setup([entry('a', 'A'), entry('b', 'B')]);
    const { set, skipped } = await repairs.setDurations([{ id: 'a', durationMs: 400 }, { id: 'b', durationMs: 13 * 3_600_000 }]);
    expect(set).toEqual([]);
    expect(skipped).toHaveLength(2);
  });
});

describe('pointing an entry at its real video', () => {
  // Sep 2: the "recording" is a notes export saved under the video's name; the
  // real video sits beside it in the recording's own folder.
  const sep2 = () => entry('sep2', 'google-meet-20260902T1035', {
    driveFolderId: 'folder-sep2',
    note: 'kept',
    files: [
      file('sep2:tab', 'google-meet-20260902t1035-recording.webm', 'vtt-as-webm'),
      file('sep2:notes', 'google-meet-20260902t1035-recording.vtt', 'notes-file', { kind: 'notes', mimeType: 'text/vtt' }),
    ],
  });
  const REAL: DriveFileMetadata = {
    id: 'real', name: 'meet-ecj-gzax-rgx-20260902T100305-recording.webm', size: '85563392', parents: ['folder-sep2'], webViewLink: 'https://drive/real',
  };

  it('swaps the video and keeps the entry — id, notes file, description', async () => {
    const { repairs, history, store } = setup([sep2()], { real: REAL });

    expect(await repairs.repointVideo('google-meet-20260902T1035', 'real')).toEqual({
      applied: false,
      entry: 'google-meet-20260902T1035',
      from: 'google-meet-20260902t1035-recording.webm',
      to: 'meet-ecj-gzax-rgx-20260902T100305-recording.webm',
    });
    expect(history.update).not.toHaveBeenCalled();

    await repairs.repointVideo('google-meet-20260902T1035', 'real', { apply: true });
    const after = store.get('sep2')!;
    expect(after.note).toBe('kept');
    expect(after.files[0]).toMatchObject({
      id: 'sep2:tab', stream: 'tab', filename: REAL.name, driveFileId: 'real', bytes: 85563392,
      locations: [{ kind: 'drive', fileId: 'real', webViewLink: 'https://drive/real' }], status: 'available',
    });
    expect(after.files[1]).toEqual(sep2().files[1]);
    expect(normalizeRecordingHistoryEntry(after)).toEqual(after);
  });

  it('finds the video by its name inside the recording\u2019s own folder', async () => {
    const { repairs, store } = setup([sep2()], { real: REAL });
    await repairs.repointVideo('google-meet-20260902T1035', 'meet-ecj-gzax-rgx-20260902T100305-recording.webm', { apply: true });
    expect(store.get('sep2')!.files[0].driveFileId).toBe('real');
  });

  it('refuses a file that is elsewhere, not a recording, unreadable, or someone else’s', async () => {
    const other = entry('other', 'Other', { files: [file('other:tab', 'x-20260101T100000-recording.webm', 'taken')] });
    const { repairs } = setup([sep2(), other], {
      real: REAL,
      elsewhere: { ...REAL, id: 'elsewhere', parents: ['another-folder'] },
      notes: { ...REAL, id: 'notes', name: 'notes.vtt' },
      trashed: { ...REAL, id: 'trashed', trashed: true },
      taken: { ...REAL, id: 'taken' },
    });
    const name = 'google-meet-20260902T1035';
    await expect(repairs.repointVideo(name, 'elsewhere')).rejects.toThrow('not in this recording’s own Drive folder'.replace('’', "'"));
    await expect(repairs.repointVideo(name, 'notes')).rejects.toThrow('is not a recording file');
    await expect(repairs.repointVideo(name, 'trashed')).rejects.toThrow('in the trash');
    await expect(repairs.repointVideo(name, 'missing')).rejects.toThrow('cannot read');
    await expect(repairs.repointVideo(name, 'taken')).rejects.toThrow('already belongs to "Other"');
    await expect(repairs.repointVideo('No such entry', 'real')).rejects.toThrow('Expected one library entry');
  });
});
