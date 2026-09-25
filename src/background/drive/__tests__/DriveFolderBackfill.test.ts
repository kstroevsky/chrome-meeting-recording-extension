/**
 * A folder id recorded here is what "File to…" later moves, so the refusals
 * matter most: recording the root or a destination as a recording's folder
 * would move a whole library.
 */
import { loadExtensionSettingsFromStorage } from '../../../shared/settings';
import { DriveFolderBackfill } from '../DriveFolderBackfill';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';

jest.mock('../../../shared/settings', () => ({
  ...jest.requireActual('../../../shared/settings'),
  loadExtensionSettingsFromStorage: jest.fn(),
}));

// <My Drive>/Google Meet Records/{Rest,Therapy}/<recording folders>, plus a stray folder elsewhere.
const FOLDERS: Record<string, { id: string; name: string; parents: string[] }> = {
  root: { id: 'root', name: 'Google Meet Records', parents: ['my-drive'] },
  rest: { id: 'rest', name: 'Rest', parents: ['root'] },
  therapy: { id: 'therapy', name: 'Therapy', parents: ['root'] },
  'aug10': { id: 'aug10', name: 'google-meet-20260810T1346', parents: ['rest'] },
  'jun19': { id: 'jun19', name: 'meet-sst-ttsy-zau-20260619T1517', parents: ['therapy'] },
  'legacy': { id: 'legacy', name: 'google-meet-20260615T1410', parents: ['root'] },
  'elsewhere': { id: 'elsewhere', name: 'Holiday', parents: ['my-drive'] },
};
const FILE_PARENTS: Record<string, string[]> = {
  'f-aug10': ['aug10'], 'f-jun19': ['jun19'], 'f-legacy': ['legacy'],
  'f-root': ['root'], 'f-rest': ['rest'], 'f-a': ['aug10'], 'f-b': ['jun19'], 'f-elsewhere': ['elsewhere'],
};

const row = (id: string, fileIds: string[], over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
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

function setup(rows: RecordingHistoryEntry[]) {
  const store = new Map(rows.map((entry) => [entry.id, entry]));
  const history = {
    listAllIncludingDeleted: jest.fn(async () => [...store.values()]),
    update: jest.fn(async (id: string, mutate: (current: RecordingHistoryEntry | undefined) => RecordingHistoryEntry | undefined) => {
      const next = mutate(store.get(id));
      if (next) store.set(id, next);
      return next;
    }),
  };
  const backfill = new DriveFolderBackfill({
    findFolder: async (name, parentId) => Object.values(FOLDERS).find((folder) =>
      folder.name === name && folder.parents[0] === (parentId ?? 'my-drive')) ?? null,
    getFolder: async (id) => FOLDERS[id] ?? null,
    getFileParents: async (fileId) => FILE_PARENTS[fileId] ?? null,
    history,
    log: jest.fn(),
  });
  return { backfill, history, store };
}

beforeEach(() => {
  (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue({
    storage: { driveRootFolderName: 'Google Meet Records', driveFolderPresets: [{ id: 'preset-therapy', name: 'Therapy' }] },
  });
});

describe('recording the Drive folder of recordings saved before it was stored', () => {
  it('records the files’ own folder and the destination it already sits in', async () => {
    const { backfill } = setup([row('aug10', ['f-aug10']), row('jun19', ['f-jun19']), row('legacy', ['f-legacy'])]);

    const { plan } = await backfill.run();

    expect(plan.skipped).toEqual([]);
    expect(plan.backfill).toEqual([
      { historyId: 'aug10', recording: 'aug10', folderId: 'aug10', folderName: 'google-meet-20260810T1346', destination: 'Rest' },
      { historyId: 'jun19', recording: 'jun19', folderId: 'jun19', folderName: 'meet-sst-ttsy-zau-20260619T1517', presetId: 'preset-therapy', destination: 'Therapy' },
      { historyId: 'legacy', recording: 'legacy', folderId: 'legacy', folderName: 'google-meet-20260615T1410', destination: '(root)' },
    ]);
  });

  it('never takes the root or a destination for a recording’s folder', async () => {
    const { backfill } = setup([
      row('loose-in-root', ['f-root']),
      row('loose-in-rest', ['f-rest']),
      row('split', ['f-a', 'f-b']),
      row('gone', ['f-missing']),
      row('stray', ['f-elsewhere']),
    ]);

    const { plan } = await backfill.run();

    expect(plan.backfill).toEqual([]);
    expect(plan.skipped).toEqual([
      { recording: 'loose-in-root', reason: 'files sit directly in the root folder' },
      { recording: 'loose-in-rest', reason: 'files sit directly in a destination folder' },
      { recording: 'split', reason: 'files are in different folders' },
      { recording: 'gone', reason: 'a file is not readable in Drive' },
      { recording: 'stray', reason: 'folder is outside the recordings folder' },
    ]);
  });

  it('only looks at live Drive recordings that have no folder yet', async () => {
    const { backfill } = setup([
      row('has-folder', ['f-aug10'], { driveFolderId: 'aug10' }),
      row('deleted', ['f-aug10'], { deletedAt: 3 }),
      row('local', ['f-aug10'], { storageMode: 'local' }),
    ]);
    const { plan } = await backfill.run();
    expect(plan).toEqual({ backfill: [], skipped: [] });
  });

  it('plans without writing, applies on request, and never overwrites a folder recorded meanwhile', async () => {
    const { backfill, history, store } = setup([row('aug10', ['f-aug10']), row('jun19', ['f-jun19'])]);

    await backfill.run();
    expect(history.update).not.toHaveBeenCalled();

    // Filed by the user between plan and apply:
    const original = history.listAllIncludingDeleted;
    history.listAllIncludingDeleted = jest.fn(async () => {
      const rows = await original();
      store.set('jun19', { ...store.get('jun19')!, driveFolderId: 'chosen-meanwhile' });
      return rows;
    });
    await backfill.run({ apply: true });

    expect(store.get('aug10')).toMatchObject({
      driveFolderId: 'aug10',
      driveFolderName: 'google-meet-20260810T1346',
      folderWebViewLink: 'https://drive.google.com/drive/folders/aug10',
    });
    expect(store.get('aug10')?.driveFolderPresetId).toBeUndefined();
    expect(store.get('jun19')?.driveFolderId).toBe('chosen-meanwhile');
  });
});
