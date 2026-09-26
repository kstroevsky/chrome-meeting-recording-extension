/**
 * The import writes library rows for files in someone's Drive, so its planning
 * is pure and tested — what it declines to touch matters as much as what it
 * imports. Folder and file names are real ones older builds left behind.
 */
import { planDestinationImport, restoreDeletedEntry, type DriveRecordingFolder } from '../driveDestinationImport';
import { normalizeRecordingHistoryEntry, type RecordingHistoryEntry } from '../../../shared/recordingHistory';

const set = (id: string, name: string, files: string[]): DriveRecordingFolder => ({
  id,
  name,
  files: files.map((file, index) => ({ id: `${id}-f${index}`, name: file, size: String(1000 + index), webViewLink: `https://drive/${id}-f${index}` })),
});
const threeOf = (id: string, name: string, stamp = name.slice(name.lastIndexOf('-') + 1)) =>
  set(id, name, [`${name.slice(0, name.lastIndexOf('-'))}-${stamp}-recording.webm`, `${name.slice(0, name.lastIndexOf('-'))}-${stamp}-mic.webm`, `${name.slice(0, name.lastIndexOf('-'))}-${stamp}-self-video.webm`]);

const libraryEntry = (id: string, fileIds: string[], over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
  id,
  name: id,
  createdAt: 1,
  storageMode: 'drive',
  status: 'complete',
  files: fileIds.map((fileId, index) => ({
    id: `${id}:${index}`, stream: 'tab', filename: 'x.webm', mimeType: 'video/webm',
    locations: [{ kind: 'drive', fileId }], delivery: { requested: 'drive', status: 'uploaded' },
    destination: 'drive', status: 'available', driveFileId: fileId,
  })),
  ...over,
});

let counter = 0;
const newId = () => `recording:new-${++counter}`;
beforeEach(() => { counter = 0; });

describe('importing the recordings already in a destination folder', () => {
  it('creates one filed entry per unknown recording folder, dated by the recording', () => {
    const plan = planDestinationImport([threeOf('folder-a', 'meet-sst-ttsy-zau-20260619T1517')], [], 'therapy', newId);

    expect(plan.relink).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.create).toHaveLength(1);
    const [entry] = plan.create;
    expect(entry).toMatchObject({
      id: 'recording:new-1',
      name: 'meet-sst-ttsy-zau-20260619T1517',
      createdAt: Date.UTC(2026, 5, 19, 15, 17),
      storageMode: 'drive',
      status: 'complete',
      driveFolderId: 'folder-a',
      driveFolderName: 'meet-sst-ttsy-zau-20260619T1517',
      folderWebViewLink: 'https://drive.google.com/drive/folders/folder-a',
      driveFolderPresetId: 'therapy',
    });
    expect(entry.files.map((file) => file.stream)).toEqual(['tab', 'mic', 'self-video']);
    expect(entry.files[0]).toMatchObject({
      id: 'recording:new-1:tab',
      locations: [{ kind: 'drive', fileId: 'folder-a-f0', webViewLink: 'https://drive/folder-a-f0' }],
      delivery: { requested: 'drive', status: 'uploaded' },
      destination: 'drive',
      status: 'available',
      bytes: 1000,
      driveFileId: 'folder-a-f0',
    });
  });

  it('writes entries the library reads back unchanged, so none is silently dropped', () => {
    const plan = planDestinationImport([threeOf('folder-a', 'meet-sst-ttsy-zau-20260619T1517')], [], 'therapy', newId);
    expect(normalizeRecordingHistoryEntry(plan.create[0])).toEqual(plan.create[0]);
  });

  it('names the recording after its file, not after a folder named at upload time', () => {
    const plan = planDestinationImport([set('aug10', 'google-meet-20260810T1346', ['meet-wse-vroh-ptm-20260810T131228-recording.webm'])], [], undefined, newId);
    expect(plan.create[0]).toMatchObject({ name: 'meet-wse-vroh-ptm-20260810T131228', createdAt: Date.UTC(2026, 7, 10, 13, 12, 28) });
    // The default destination files nothing: what is in it is unfiled.
    expect(plan.create[0].driveFolderPresetId).toBeUndefined();
  });

  it('reads the names older builds wrote', () => {
    const plan = planDestinationImport([
      set('epoch', 'google-meet-20260311T1604', [
        'google-meet-recording-google-meet-1773245064320.webm',
        'google-meet-self-video-google-meet-1773245064324.webm',
        'google-meet-mic-google-meet-1773245064320.webm',
      ]),
      set('dup', 'google-meet-sst-ttsy-zau-20260417T1618', [
        'google-meet-sst-ttsy-zau-20260417T1618-self-video (1).webm',
        'google-meet-sst-ttsy-zau-20260417T1618-recording (1).webm',
        'google-meet-sst-ttsy-zau-20260417T1618-mic (1).webm',
      ]),
    ], [], 'therapy', newId);

    expect(plan.create.map((entry) => [entry.name, entry.createdAt, entry.files.length])).toEqual([
      ['google-meet-20260311T160424', 1773245064320, 3],
      ['google-meet-sst-ttsy-zau-20260417T1618', Date.UTC(2026, 3, 17, 16, 18), 3],
    ]);
  });

  it('re-points a live entry at the folder its files are in now, instead of duplicating it', () => {
    const folder = threeOf('new-folder', 'meet-sst-ttsy-zau-20260717T152324');
    const known = libraryEntry('recording:jul17', folder.files.map((file) => file.id), { driveFolderId: 'old-folder' });

    const plan = planDestinationImport([folder], [known], 'therapy', newId);

    expect(plan.create).toEqual([]);
    expect(plan.relink).toEqual([{ historyId: 'recording:jul17', folderId: 'new-folder', folderName: 'meet-sst-ttsy-zau-20260717T152324' }]);
  });

  it('does nothing on a second run', () => {
    const folder = threeOf('folder-a', 'meet-sst-ttsy-zau-20260619T1517');
    const first = planDestinationImport([folder], [], 'therapy', newId);
    expect(planDestinationImport([folder], first.create, 'therapy', newId))
      .toEqual({ create: [], relink: [], skipped: [], removed: [] });
  });

  it('leaves a recording the user removed from the library out of it', () => {
    const folder = threeOf('folder-jul10', 'meet-sst-ttsy-zau-20260710T151550');
    const removed = libraryEntry('recording:jul10', [folder.files[0].id], { deletedAt: 5 });

    const plan = planDestinationImport([folder], [removed], 'therapy', newId);

    expect(plan.create).toEqual([]);
    expect(plan.relink).toEqual([]);
    expect(plan.skipped).toEqual([{ folder: 'meet-sst-ttsy-zau-20260710T151550', reason: 'removed from the library' }]);
    expect(plan.removed).toEqual([{ historyId: 'recording:jul10', name: 'recording:jul10', folderId: 'folder-jul10', folderName: 'meet-sst-ttsy-zau-20260710T151550' }]);
  });

  it('declines folders it cannot read as exactly one recording', () => {
    const plan = planDestinationImport([
      set('empty', 'chat-gpt-test', ['chat-gpt-test-recording.webm']),
      set('twice', 'google-meet-20260615T1410', [
        'google-meet-20260615T1410-mic.webm', 'google-meet-20260615T1410-mic.webm',
      ]),
      threeOf('split', 'meet-x-20260101T100000'),
    ], [
      libraryEntry('recording:a', ['split-f0']),
      libraryEntry('recording:b', ['split-f1']),
    ], 'therapy', newId);

    expect(plan.create).toEqual([]);
    expect(plan.skipped).toEqual([
      { folder: 'chat-gpt-test', reason: 'no recording files' },
      { folder: 'google-meet-20260615T1410', reason: 'more than one file per stream' },
      { folder: 'meet-x-20260101T100000', reason: 'files belong to several library entries' },
    ]);
  });

  it('ignores sidecars beside the media rather than refusing the folder', () => {
    const folder = threeOf('with-notes', 'meet-aeo-jyrw-bis-20260904T170207');
    folder.files.push({ id: 'notes', name: 'meet-aeo-jyrw-bis-20260904T170207-notes.vtt' });

    const plan = planDestinationImport([folder], [], 'therapy', newId);

    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].files.map((file) => file.driveFileId)).not.toContain('notes');
  });

  it('restores a removed entry as it was, at its folder now, without the local copy its removal deleted', () => {
    const removed = libraryEntry('recording:jul10', ['f1'], {
      note: 'kept description', deletedAt: 5, cleanupPending: true, driveFolderId: 'old-folder',
    });
    removed.files[0].locations.push({ kind: 'opfs', key: 'opfs-key', retainedAt: 1 });

    const restored = restoreDeletedEntry(removed, { id: 'new-folder', name: 'meet-sst-ttsy-zau-20260710T151550' }, 'therapy');

    expect(restored).toMatchObject({
      id: 'recording:jul10', note: 'kept description',
      driveFolderId: 'new-folder', driveFolderName: 'meet-sst-ttsy-zau-20260710T151550', driveFolderPresetId: 'therapy',
    });
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.cleanupPending).toBeUndefined();
    expect(restored.files[0].locations).toEqual([{ kind: 'drive', fileId: 'f1' }]);
    expect(normalizeRecordingHistoryEntry(restored)).toEqual(restored);
  });
});
