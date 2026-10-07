import { registerSaveHandler } from '../LocalDeliveryRuntime';
import { LocalDeliveryOrchestrator } from '../LocalDeliveryOrchestrator';

jest.mock('../LocalDeliveryRuntime', () => ({
  registerSaveHandler: jest.fn(),
}));
jest.mock('../../../shared/settings', () => ({
  ...jest.requireActual('../../../shared/settings'),
  loadExtensionSettingsFromStorage: jest.fn(async () => ({
    storage: { localFolderPresets: [{ id: 'folder-1', name: 'Interviews' }] },
  })),
}));

describe('LocalDeliveryOrchestrator', () => {
  let deliverDeferred: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    deliverDeferred = jest.fn().mockResolvedValue([]);
    (registerSaveHandler as jest.Mock).mockReturnValue({
      deliverDeferred,
    });
  });

  function create(overrides: {
    get?: jest.Mock;
    history?: Record<string, jest.Mock>;
    listPage?: jest.Mock;
    destinationFolderId?: (recordingId: string) => Promise<string | undefined>;
  } = {}) {
    const history = overrides.history ?? { setLocalFolder: jest.fn() };
    const get = overrides.get ?? jest.fn();
    return new LocalDeliveryOrchestrator(
      {} as never,
      history as never,
      { listPage: overrides.listPage ?? jest.fn(), get } as never,
      () => undefined,
      { log: jest.fn(), warn: jest.fn() },
      overrides.destinationFolderId,
    );
  }

  it('schedules a short recovery alarm when a local delivery is deferred', async () => {
    create();
    const deferred = (registerSaveHandler as jest.Mock).mock.calls[0][5] as () => void;

    deferred();
    await Promise.resolve();

    expect(chrome.alarms.create).toHaveBeenCalledWith(
      'local-delivery-timeout',
      { delayInMinutes: 0.5 },
    );
  });

  it('reconciles only the local-delivery alarm', async () => {
    const orchestrator = create();
    const reconcile = jest.spyOn(orchestrator, 'reconcileAbandoned').mockResolvedValue(true);

    orchestrator.handleAlarm({ name: 'other' });
    expect(reconcile).not.toHaveBeenCalled();

    orchestrator.handleAlarm({ name: 'local-delivery-timeout' });
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects a user delivery when no requested artifact was actually attempted', async () => {
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get });

    await expect(orchestrator.deliver('r1', null)).rejects.toThrow(
      'This recording has no pending local files to deliver',
    );
  });

  it('rejects a partially failed user delivery instead of returning success', async () => {
    deliverDeferred.mockResolvedValue([
      { status: 'complete', downloadId: 1 },
      { status: 'not-started', error: 'missing' },
    ]);
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get });

    await expect(orchestrator.deliver('r1', null)).rejects.toThrow(
      'Local delivery did not fully complete (complete, not-started)',
    );
  });

  it('records the folder only after every requested artifact completes', async () => {
    deliverDeferred.mockResolvedValue([{ status: 'complete', downloadId: 1 }]);
    const history = { setLocalFolder: jest.fn().mockResolvedValue(undefined) };
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get, history });

    await expect(orchestrator.deliver('r1', null)).resolves.toBeUndefined();
    expect(history.setLocalFolder).toHaveBeenCalledWith('r1', undefined);
  });

  it('reports startup reconciliation incomplete while retryable local delivery remains pending', async () => {
    deliverDeferred.mockResolvedValue([{ status: 'not-started', error: 'offscreen unavailable' }]);
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get });
    jest.spyOn(orchestrator, 'listPending')
      .mockResolvedValueOnce([{ id: 'r1', name: 'demo' }])
      .mockResolvedValueOnce([{ id: 'r1', name: 'demo' }]);

    await expect(orchestrator.reconcileAbandoned()).resolves.toBe(false);
    expect(deliverDeferred).toHaveBeenCalledTimes(1);
  });

  it('reports startup reconciliation complete after pending delivery clears', async () => {
    deliverDeferred.mockResolvedValue([{ status: 'complete', downloadId: 1 }]);
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get });
    jest.spyOn(orchestrator, 'listPending')
      .mockResolvedValueOnce([{ id: 'r1', name: 'demo' }])
      .mockResolvedValueOnce([]);

    await expect(orchestrator.reconcileAbandoned()).resolves.toBe(true);
    expect(deliverDeferred).toHaveBeenCalledTimes(1);
  });

  describe('the folder a Save to destination files into', () => {
    const pendingEntry = (id: string) => ({
      id, name: id, status: 'complete', files: [{ kind: 'tab', delivery: { status: 'pending' }, locations: [{ kind: 'opfs' }] }],
    });
    const listPage = () => jest.fn().mockResolvedValue({ entries: [pendingEntry('r1'), pendingEntry('r2'), pendingEntry('r3')] });

    it('names it for each pending recording, while that folder still exists', async () => {
      const folders: Record<string, string | undefined> = { r1: 'folder-1', r2: 'folder-gone', r3: undefined };
      const orchestrator = create({ listPage: listPage(), destinationFolderId: async (id) => folders[id] });

      await expect(orchestrator.listPending()).resolves.toEqual([
        { id: 'r1', name: 'r1', folderId: 'folder-1' },
        { id: 'r2', name: 'r2' },
        { id: 'r3', name: 'r3' },
      ]);
    });

    it('is where a recording nobody was asked about lands', async () => {
      deliverDeferred.mockResolvedValue([{ status: 'complete', downloadId: 1 }]);
      const history = { setLocalFolder: jest.fn().mockResolvedValue(undefined) };
      const entry = { id: 'r1', files: [], name: 'demo' };
      const orchestrator = create({ get: jest.fn().mockResolvedValue(entry), history });
      jest.spyOn(orchestrator, 'listPending')
        .mockResolvedValueOnce([{ id: 'r1', name: 'demo', folderId: 'folder-1' }])
        .mockResolvedValueOnce([]);

      await expect(orchestrator.reconcileAbandoned()).resolves.toBe(true);
      expect(deliverDeferred).toHaveBeenCalledWith(entry, 'Interviews');
      expect(history.setLocalFolder).toHaveBeenCalledWith('r1', 'Interviews');
    });
  });
});
