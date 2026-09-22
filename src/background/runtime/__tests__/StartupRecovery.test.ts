import {
  hasLibraryDirectory,
} from '../../../offscreen/storage/opfsLayout';
import { reconcileRetainedMedia } from '../../retention/RetainedMediaReconciler';
import { ensurePersistentStorage } from '../../retention/storageDurability';
import { StartupRecovery } from '../StartupRecovery';

jest.mock('../../../offscreen/storage/opfsLayout', () => ({
  existsByKey: jest.fn(),
  hasLibraryDirectory: jest.fn().mockResolvedValue(true),
  listLibraryFiles: jest.fn().mockResolvedValue([]),
  removeByKey: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../retention/RetainedMediaReconciler', () => ({
  reconcileRetainedMedia: jest.fn().mockResolvedValue({
    healthy: 0,
    repaired: 0,
    collected: 0,
    deferred: 0,
    staleLocations: 0,
  }),
}));
jest.mock('../../retention/storageDurability', () => ({
  ensurePersistentStorage: jest.fn().mockResolvedValue(true),
}));

const hasLibraryMock = hasLibraryDirectory as jest.MockedFunction<typeof hasLibraryDirectory>;
const reconcileRetainedMock = reconcileRetainedMedia as jest.MockedFunction<typeof reconcileRetainedMedia>;
const ensurePersistentStorageMock = ensurePersistentStorage as jest.MockedFunction<typeof ensurePersistentStorage>;

describe('StartupRecovery', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  let historyRepository: any;
  let history: any;
  let localDelivery: any;
  let driveAuthLease: any;
  let playbackLeases: any;
  let getDirectory: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({});
    (chrome.storage.session.set as jest.Mock).mockResolvedValue(undefined);
    (chrome.tabs.query as jest.Mock).mockResolvedValue([{ id: 3 }, { id: 9 }, {}]);
    getDirectory = jest.fn().mockResolvedValue({});
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { getDirectory },
    });
    hasLibraryMock.mockResolvedValue(true);
    reconcileRetainedMock.mockResolvedValue({
      healthy: 0,
      repaired: 0,
      collected: 0,
      deferred: 0,
      staleLocations: 0,
    });
    ensurePersistentStorageMock.mockResolvedValue(true);
    historyRepository = {
      get: jest.fn(),
      listPage: jest.fn().mockResolvedValue({ entries: [] }),
    };
    history = {
      list: jest.fn().mockResolvedValue([]),
      recordArtifactLocation: jest.fn(),
      dropArtifactLocation: jest.fn(),
      retryPendingCleanup: jest.fn().mockResolvedValue(true),
    };
    localDelivery = { reconcileAbandoned: jest.fn().mockResolvedValue(undefined) };
    driveAuthLease = { reconcile: jest.fn().mockResolvedValue(0) };
    playbackLeases = { reconcile: jest.fn().mockResolvedValue(0) };
  });

  const run = () => new StartupRecovery(
    historyRepository,
    history,
    localDelivery,
    driveAuthLease,
    playbackLeases,
    logger,
  ).run();

  it('runs crash reconciliation once and cleans leases against live tabs', async () => {
    driveAuthLease.reconcile.mockResolvedValue(1);
    playbackLeases.reconcile.mockResolvedValue(2);

    await run();

    expect(chrome.storage.session.set).toHaveBeenCalledWith({ retainedMediaReconciled: true });
    expect(reconcileRetainedMock).toHaveBeenCalledTimes(1);
    expect(ensurePersistentStorageMock).toHaveBeenCalledTimes(1);
    expect(history.retryPendingCleanup).toHaveBeenCalledTimes(1);
    expect(localDelivery.reconcileAbandoned).toHaveBeenCalledTimes(1);
    expect(driveAuthLease.reconcile).toHaveBeenCalledWith([3, 9]);
    expect(playbackLeases.reconcile).toHaveBeenCalledWith([3, 9]);
    expect(logger.log).toHaveBeenCalledWith('Dropped 1 orphaned Drive playback rule(s)');
    expect(logger.log).toHaveBeenCalledWith(
      'Freed retained media for 2 recording(s) whose player is gone',
    );
  });

  it('skips all startup work when this browser session was already reconciled', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ retainedMediaReconciled: true });

    await run();

    expect(chrome.storage.session.set).not.toHaveBeenCalled();
    expect(reconcileRetainedMock).not.toHaveBeenCalled();
    expect(ensurePersistentStorageMock).not.toHaveBeenCalled();
    expect(localDelivery.reconcileAbandoned).not.toHaveBeenCalled();
    expect(driveAuthLease.reconcile).not.toHaveBeenCalled();
  });

  it('continues startup when retained-media reconciliation fails', async () => {
    reconcileRetainedMock.mockRejectedValue(new Error('OPFS unavailable'));

    await run();

    expect(logger.warn).toHaveBeenCalledWith(
      'Retained-media reconciliation failed (non-fatal):',
      expect.any(Error),
    );
    expect(ensurePersistentStorageMock).toHaveBeenCalledTimes(1);
    expect(localDelivery.reconcileAbandoned).toHaveBeenCalledTimes(1);
    expect(driveAuthLease.reconcile).toHaveBeenCalledTimes(1);
    expect(chrome.storage.session.set).not.toHaveBeenCalledWith({ retainedMediaReconciled: true });
  });

  it('continues lease cleanup when deferred local delivery reconciliation fails', async () => {
    hasLibraryMock.mockRejectedValue(new Error('OPFS unavailable'));

    await run();

    expect(logger.warn).toHaveBeenCalledWith(
      'Reconciling deferred local deliveries failed (non-fatal):',
      expect.any(Error),
    );
    expect(driveAuthLease.reconcile).toHaveBeenCalledTimes(1);
    expect(playbackLeases.reconcile).toHaveBeenCalledTimes(1);
    expect(chrome.storage.session.set).not.toHaveBeenCalledWith({ retainedMediaReconciled: true });
  });

  it('keeps startup reconciliation retryable while deleted history cleanup is incomplete', async () => {
    history.retryPendingCleanup.mockResolvedValue(false);

    await run();

    expect(localDelivery.reconcileAbandoned).toHaveBeenCalledTimes(1);
    expect(driveAuthLease.reconcile).toHaveBeenCalledTimes(1);
    expect(chrome.storage.session.set).not.toHaveBeenCalledWith({ retainedMediaReconciled: true });
  });

  it('keeps startup reconciliation retryable when deleted history cleanup cannot be enumerated', async () => {
    history.retryPendingCleanup.mockRejectedValue(new Error('history unavailable'));

    await run();

    expect(logger.warn).toHaveBeenCalledWith(
      'Reconciling deleted recording cleanup failed (non-fatal):',
      expect.any(Error),
    );
    expect(chrome.storage.session.set).not.toHaveBeenCalledWith({ retainedMediaReconciled: true });
  });

  it('marks reconciliation complete only after every startup pass succeeds', async () => {
    const order: string[] = [];
    reconcileRetainedMock.mockImplementation(async () => {
      order.push('retained');
      return { healthy: 0, repaired: 0, collected: 0, deferred: 0, staleLocations: 0 };
    });
    localDelivery.reconcileAbandoned.mockImplementation(async () => { order.push('delivery'); });
    driveAuthLease.reconcile.mockImplementation(async () => { order.push('leases'); return 0; });
    (chrome.storage.session.set as jest.Mock).mockImplementation(async () => { order.push('marker'); });

    await run();

    expect(order.indexOf('marker')).toBeGreaterThan(order.indexOf('retained'));
    expect(order.indexOf('marker')).toBeGreaterThan(order.indexOf('delivery'));
    expect(order.indexOf('marker')).toBeGreaterThan(order.indexOf('leases'));
  });

  it('gives retained-location reconciliation every history page', async () => {
    historyRepository.listPage
      .mockResolvedValueOnce({
        entries: [{ id: 'r1' }, { id: 'deleted', deletedAt: 9 }],
        nextCursor: { createdAt: 2, id: 'r1' },
      })
      .mockResolvedValueOnce({ entries: [{ id: 'r2' }] });
    reconcileRetainedMock.mockImplementation(async (deps: any) => {
      await expect(deps.listLiveEntries()).resolves.toEqual([{ id: 'r1' }, { id: 'r2' }]);
      return { healthy: 0, repaired: 0, collected: 0, deferred: 0, staleLocations: 0 };
    });

    await run();

    expect(historyRepository.listPage).toHaveBeenCalledTimes(2);
  });
});
