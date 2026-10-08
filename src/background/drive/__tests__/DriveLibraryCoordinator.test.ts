import { loadExtensionSettingsFromStorage } from '../../../shared/settings';
import { DriveDestinationFiler } from '../DriveDestinationFiler';
import { DriveLibraryCoordinator } from '../DriveLibraryCoordinator';

jest.mock('../driveAuth', () => ({
  fetchDriveTokenWithFallback: jest.fn().mockResolvedValue({ ok: true, token: 'narrow-token' }),
}));

jest.mock('../../../shared/settings', () => ({
  ...jest.requireActual('../../../shared/settings'),
  loadExtensionSettingsFromStorage: jest.fn(),
}));

describe('DriveLibraryCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue({
      storage: {
        driveFolderPresets: [{ id: 'preset-1', name: 'Clients' }],
        driveRootFolderName: 'Recordings',
      },
    });
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({ driveDestinationsGathered: true });
  });

  it('files the Drive folder before recording the destination in history', async () => {
    const file = jest.spyOn(DriveDestinationFiler.prototype, 'file')
      .mockResolvedValue({ status: 'filed', destinationFolderId: 'destination-1' });
    const historyRepository = {
      get: jest.fn().mockResolvedValue({
        id: 'recording-1',
        name: 'Call',
        createdAt: 1,
        files: [],
        driveFolderId: 'folder-1',
      }),
    };
    const history = { setDriveDestination: jest.fn().mockResolvedValue(undefined) };
    const coordinator = new DriveLibraryCoordinator(
      historyRepository as never,
      history as never,
      { log: jest.fn(), warn: jest.fn() },
    );

    await coordinator.fileRecordingToDestination('recording-1', 'preset-1');

    expect(file).toHaveBeenCalledWith('folder-1', 'Clients', 'Recordings');
    expect(history.setDriveDestination).toHaveBeenCalledWith('recording-1', 'preset-1');
    expect(file.mock.invocationCallOrder[0]).toBeLessThan(
      history.setDriveDestination.mock.invocationCallOrder[0],
    );
  });

  it('does not mutate history when the recording is no longer available', async () => {
    const history = { setDriveDestination: jest.fn() };
    const coordinator = new DriveLibraryCoordinator(
      { get: jest.fn().mockResolvedValue(null) } as never,
      history as never,
      { log: jest.fn(), warn: jest.fn() },
    );

    await expect(coordinator.fileRecordingToDestination('missing', 'preset-1'))
      .rejects.toThrow('no longer available');
    expect(history.setDriveDestination).not.toHaveBeenCalled();
  });

  describe('importing a destination folder into the library', () => {
    const FOLDER = 'application/vnd.google-apps.folder';
    const children: Record<string, Array<{ id: string; name: string; mimeType: string; size?: string }>> = {
      'dest-therapy': [
        { id: 'rec-new', name: 'meet-sst-ttsy-zau-20260619T1517', mimeType: FOLDER },
        { id: 'rec-known', name: 'meet-sst-ttsy-zau-20260717T152324', mimeType: FOLDER },
      ],
      'rec-new': ['recording', 'mic', 'self-video'].map((stream, index) => ({
        id: `new-${index}`, name: `meet-sst-ttsy-zau-20260619T1517-${stream}.webm`, mimeType: 'video/webm', size: '10',
      })),
      'rec-known': [{ id: 'known-0', name: 'meet-sst-ttsy-zau-20260717T152324-recording.webm', mimeType: 'video/webm' }],
    };
    const folders: Record<string, { id: string; name: string }> = {
      "root|Recordings": { id: 'root-1', name: 'Recordings' },
      "root-1|Therapy": { id: 'dest-therapy', name: 'Therapy' },
    };
    const known = {
      id: 'recording:jul17', name: 'Jul 17', createdAt: 1, storageMode: 'drive', status: 'complete', driveFolderId: 'somewhere-else',
      files: [{ id: 'recording:jul17:tab', stream: 'tab', filename: 'x.webm', mimeType: 'video/webm', locations: [{ kind: 'drive', fileId: 'known-0' }],
        delivery: { requested: 'drive', status: 'uploaded' }, destination: 'drive', status: 'available', driveFileId: 'known-0' }],
    };

    beforeEach(() => {
      (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue({
        storage: { driveFolderPresets: [{ id: 'preset-therapy', name: 'Therapy' }], driveRootFolderName: 'Recordings' },
      });
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const q = decodeURIComponent(new URL(String(input)).searchParams.get('q') ?? '');
        const parent = q.match(/'([^']+)' in parents/)?.[1] ?? '';
        const name = q.match(/name = '([^']+)'/)?.[1];
        const files = name ? [folders[`${parent}|${name}`]].filter(Boolean) : children[parent] ?? [];
        return { ok: true, status: 200, json: async () => ({ files }) } as Response;
      }) as typeof fetch;
    });

    const repositoryWith = (rows: unknown[]) => {
      const store = new Map(rows.map((row) => [(row as { id: string }).id, row]));
      return {
        store,
        listAllIncludingDeleted: jest.fn(async () => [...store.values()]),
        update: jest.fn(async (id: string, mutate: (current: unknown) => unknown) => {
          const next = mutate(store.get(id));
          if (next) store.set(id, next);
          return next;
        }),
      };
    };

    it('plans without writing, then applies, then has nothing left to do', async () => {
      const repository = repositoryWith([known]);
      const coordinator = new DriveLibraryCoordinator(repository as never, {} as never, { log: jest.fn(), warn: jest.fn() });

      const planned = await coordinator.importer.importDestination('therapy');
      expect(planned.applied).toBe(false);
      expect(planned.plan.create.map((entry) => entry.name)).toEqual(['meet-sst-ttsy-zau-20260619T1517']);
      expect(planned.plan.relink).toEqual([{ historyId: 'recording:jul17', folderId: 'rec-known', folderName: 'meet-sst-ttsy-zau-20260717T152324' }]);
      expect(repository.update).not.toHaveBeenCalled();

      await coordinator.importer.importDestination('Therapy', { apply: true });
      const created = [...repository.store.values()].find((row) => (row as { name: string }).name === 'meet-sst-ttsy-zau-20260619T1517');
      expect(created).toMatchObject({ driveFolderId: 'rec-new', driveFolderPresetId: 'preset-therapy' });
      expect(repository.store.get('recording:jul17')).toMatchObject({ driveFolderId: 'rec-known', driveFolderPresetId: 'preset-therapy' });

      const again = await coordinator.importer.importDestination('Therapy');
      expect(again.plan).toEqual({ create: [], relink: [], skipped: [], removed: [] });
    });

    it('imports the default destination as unfiled, without it being a preset', async () => {
      folders['root-1|Rest'] = { id: 'dest-rest', name: 'Rest' };
      children['dest-rest'] = [{ id: 'rec-rest', name: 'google-meet-20260810T1346', mimeType: FOLDER }];
      children['rec-rest'] = [{ id: 'rest-0', name: 'meet-wse-vroh-ptm-20260810T131228-recording.webm', mimeType: 'video/webm' }];
      const repository = repositoryWith([]);
      const coordinator = new DriveLibraryCoordinator(repository as never, {} as never, { log: jest.fn(), warn: jest.fn() });

      await coordinator.importer.importDestination('Rest', { apply: true });

      const [created] = [...repository.store.values()] as Array<Record<string, unknown>>;
      expect(created).toMatchObject({ name: 'meet-wse-vroh-ptm-20260810T131228', driveFolderId: 'rec-rest' });
      expect(created.driveFolderPresetId).toBeUndefined();
    });

    it('restores one removed recording by its folder, and only when asked', async () => {
      const removed = { ...known, id: 'recording:jul10', name: 'Jul 10', deletedAt: 9, cleanupPending: true };
      children['rec-known'] = [{ id: 'known-0', name: 'meet-sst-ttsy-zau-20260717T152324-recording.webm', mimeType: 'video/webm' }];
      const repository = repositoryWith([removed]);
      const coordinator = new DriveLibraryCoordinator(repository as never, {} as never, { log: jest.fn(), warn: jest.fn() });

      const planned = await coordinator.importer.restoreFolder('Therapy', 'meet-sst-ttsy-zau-20260717T152324');
      expect(planned).toEqual({ applied: false, restored: { historyId: 'recording:jul10', name: 'Jul 10', folderId: 'rec-known' } });
      expect(repository.update).not.toHaveBeenCalled();

      await coordinator.importer.restoreFolder('Therapy', 'meet-sst-ttsy-zau-20260717T152324', { apply: true });
      const restored = repository.store.get('recording:jul10') as Record<string, unknown>;
      expect(restored).toMatchObject({ driveFolderId: 'rec-known', driveFolderPresetId: 'preset-therapy' });
      expect(restored.deletedAt).toBeUndefined();

      await expect(coordinator.importer.restoreFolder('Therapy', 'meet-sst-ttsy-zau-20260717T152324'))
        .rejects.toThrow('is already in the library');
      await expect(coordinator.importer.restoreFolder('Therapy', 'no-such-folder'))
        .rejects.toThrow('Expected one folder "no-such-folder"');
    });

    it('refuses a destination that is not in Settings, before touching Drive', async () => {
      const coordinator = new DriveLibraryCoordinator(repositoryWith([]) as never, {} as never, { log: jest.fn(), warn: jest.fn() });
      await expect(coordinator.importer.importDestination('Work')).rejects.toThrow('Add "Work" as a destination in Settings first');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
