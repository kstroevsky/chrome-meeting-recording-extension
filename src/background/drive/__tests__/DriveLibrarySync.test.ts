/**
 * One library, one Drive, every case sync must handle — and the promise that
 * the preview writes nothing and apply writes only what was chosen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadExtensionSettingsFromStorage } from '../../../shared/settings';
import { DriveLibrarySync } from '../DriveLibrarySync';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';

jest.mock('../../../shared/settings', () => ({
  ...jest.requireActual('../../../shared/settings'),
  loadExtensionSettingsFromStorage: jest.fn(),
}));

const FOLDER = 'application/vnd.google-apps.folder';
const WEBM = new Uint8Array(readFileSync(join(__dirname, '../../../../tests/fixtures/webm/with-duration.webm')));

// Google Meet Records/{Rest,Therapy}/<recording folders>
const TREE: Record<string, Array<{ id: string; name: string; mimeType?: string; size?: string }>> = {
  rest: [
    { id: 'f-removed', name: 'google-meet-20260710T1450', mimeType: FOLDER },
    { id: 'f-duration', name: 'google-meet-20260810T1346', mimeType: FOLDER },
    { id: 'f-mixed', name: 'google-meet-20260615T1410', mimeType: FOLDER },
  ],
  therapy: [
    { id: 'f-moved', name: 'meet-sst-ttsy-zau-20260724T160500', mimeType: FOLDER },
    { id: 'f-new', name: 'meet-sst-ttsy-zau-20260925T150000', mimeType: FOLDER },
  ],
  'f-removed': [{ id: 'removed-tab', name: 'x-20260710T145000-recording.webm' }],
  'f-duration': [{ id: 'duration-tab', name: 'meet-wse-vroh-ptm-20260810T131228-recording.webm', size: String(WEBM.length) }],
  'f-mixed': [{ id: 'm1', name: 'google-meet-20260615T1410-mic.webm' }, { id: 'm2', name: 'google-meet-20260615T1410-mic.webm' }],
  'f-moved': [{ id: 'moved-tab', name: 'meet-sst-ttsy-zau-20260724T160500-recording.webm' }],
  'f-new': [{ id: 'new-tab', name: 'meet-sst-ttsy-zau-20260925T150000-recording.webm' }],
};
const FOLDERS: Record<string, { id: string; name: string }> = {
  'my-drive|Google Meet Records': { id: 'root', name: 'Google Meet Records' },
  'root|Rest': { id: 'rest', name: 'Rest' },
  'root|Therapy': { id: 'therapy', name: 'Therapy' },
};

const file = (driveFileId: string) => ({
  id: `${driveFileId}:f`, stream: 'tab' as const, filename: `${driveFileId}.webm`, mimeType: 'video/webm',
  locations: [{ kind: 'drive' as const, fileId: driveFileId }], delivery: { requested: 'drive' as const, status: 'uploaded' as const },
  destination: 'drive' as const, status: 'available' as const, driveFileId,
});
const entry = (id: string, driveFileId: string, over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
  id, name: id, createdAt: 1, storageMode: 'drive', status: 'complete', files: [file(driveFileId)], durationMs: 60_000, ...over,
});

function setup() {
  const store = new Map<string, RecordingHistoryEntry>([
    ['moved', entry('moved', 'moved-tab', { driveFolderId: 'old-folder-in-rest' })],
    ['removed', entry('removed', 'removed-tab', { deletedAt: 5 })],
    ['no-duration', entry('no-duration', 'duration-tab', { driveFolderId: 'f-duration', durationMs: undefined })],
    ['trashed', entry('trashed', 'trashed-tab')],
  ]);
  const history = {
    listAllIncludingDeleted: jest.fn(async () => [...store.values()]),
    update: jest.fn(async (id: string, mutate: (current: RecordingHistoryEntry | undefined) => RecordingHistoryEntry | undefined) => {
      const next = mutate(store.get(id));
      if (next) store.set(id, next);
      return next;
    }),
  };
  const backfill = { run: jest.fn(async (options?: { apply?: boolean }) => ({ applied: !!options?.apply, plan: { backfill: [], skipped: [] } })) };
  const sync = new DriveLibrarySync({
    findFolder: async (name, parent) => FOLDERS[`${parent ?? 'my-drive'}|${name}`] ?? null,
    listChildren: async (id) => TREE[id] ?? [],
    fileState: async (id) => (id === 'trashed-tab' ? 'trashed' : 'ok'),
    readRange: async (id, from, to) => (id === 'duration-tab' ? WEBM.slice(from, to + 1) : null),
    history,
    backfill,
    log: jest.fn(),
  });
  return { sync, store, history, backfill };
}

beforeEach(() => {
  (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue({
    storage: { driveRootFolderName: 'Google Meet Records', driveFolderPresets: [{ id: 'preset-therapy', name: 'Therapy' }] },
  });
});

describe('Sync with Drive', () => {
  it('previews moves, what is not in the library, what is missing and what lacks a duration — writing nothing', async () => {
    const { sync, history } = setup();
    const plan = await sync.plan();

    expect(plan.moves).toEqual([{ historyId: 'moved', name: 'moved', folderName: 'meet-sst-ttsy-zau-20260724T160500', destination: 'Therapy' }]);
    expect(plan.notInLibrary).toEqual([
      { folderId: 'f-removed', folderName: 'google-meet-20260710T1450', destination: 'Rest', kind: 'removed', name: 'removed' },
      { folderId: 'f-new', folderName: 'meet-sst-ttsy-zau-20260925T150000', destination: 'Therapy', kind: 'new', name: 'meet-sst-ttsy-zau-20260925T150000' },
    ]);
    expect(plan.missing).toEqual([{ historyId: 'trashed', name: 'trashed', problem: 'in the Drive trash' }]);
    expect(plan.durations).toBe(1);
    expect(plan.leftAlone).toEqual([{ folder: 'google-meet-20260615T1410', destination: 'Rest', reason: 'more than one file per stream' }]);
    expect(history.update).not.toHaveBeenCalled();
  });

  it('applies only what was chosen: moves, durations, and the one recording brought back', async () => {
    const { sync, store, backfill } = setup();
    const result = await sync.apply({ moves: true, durations: true, bringBack: ['f-removed'] });

    expect(result).toEqual({ moved: 1, broughtBack: 1, durations: 1, durationsUnreadable: 0 });
    expect(store.get('moved')).toMatchObject({ driveFolderId: 'f-moved', driveFolderPresetId: 'preset-therapy' });
    expect(store.get('removed')?.deletedAt).toBeUndefined();
    expect(store.get('removed')).toMatchObject({ driveFolderId: 'f-removed' });
    expect(store.get('removed')?.driveFolderPresetId).toBeUndefined();
    expect(store.get('no-duration')?.durationMs).toBe(4008);
    expect([...store.values()].some((row) => row.driveFolderId === 'f-new')).toBe(false);
    expect(backfill.run).toHaveBeenCalledWith({ apply: true });
    expect(store.get('trashed')?.deletedAt).toBeUndefined();
  });

  it('writes nothing it was not asked to', async () => {
    const { sync, history, backfill } = setup();
    expect(await sync.apply({ moves: false, durations: false, bringBack: [] }))
      .toEqual({ moved: 0, broughtBack: 0, durations: 0, durationsUnreadable: 0 });
    expect(history.update).not.toHaveBeenCalled();
    expect(backfill.run).not.toHaveBeenCalledWith({ apply: true });
  });

  it('brings a new recording in only when it is chosen', async () => {
    const { sync, store } = setup();
    await sync.apply({ moves: false, durations: false, bringBack: ['f-new'] });
    const created = [...store.values()].find((row) => row.driveFolderId === 'f-new');
    expect(created).toMatchObject({ name: 'meet-sst-ttsy-zau-20260925T150000', driveFolderPresetId: 'preset-therapy' });
  });
});
