import { getPerfSettingsSnapshot } from '../../../shared/perf';
import { createIdleSession, type RecordingSessionSnapshot } from '../../../shared/recording';
import { getSessionStorageValuesStrict } from '../../../platform/chrome/storage';
import { startKeepAlive, stopKeepAlive } from '../KeepAlive';
import { CriticalWorkCoordinator } from '../CriticalWorkCoordinator';
import { bootstrapBackground } from '../bootstrap';

jest.mock('../../../platform/chrome/storage', () => ({
  getSessionStorageValuesStrict: jest.fn(),
}));
jest.mock('../KeepAlive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));
jest.mock('../../../shared/perf', () => {
  const actual = jest.requireActual('../../../shared/perf');
  return {
    ...actual,
    configurePerfRuntime: jest.fn(async () => actual.getPerfSettingsSnapshot()),
  };
});

const storageMock = getSessionStorageValuesStrict as jest.MockedFunction<typeof getSessionStorageValuesStrict>;
const startKeepAliveMock = startKeepAlive as jest.MockedFunction<typeof startKeepAlive>;
const stopKeepAliveMock = stopKeepAlive as jest.MockedFunction<typeof stopKeepAlive>;

describe('bootstrapBackground', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  let snapshot: RecordingSessionSnapshot;
  let session: any;
  let offscreen: any;
  let telemetry: any;
  let perfDebugStore: any;
  let criticalWork: any;
  let startupRecovery: any;
  let markSessionHydrated: jest.Mock;
  let resumePendingFinalization: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    snapshot = createIdleSession();
    storageMock.mockResolvedValue({});
    session = {
      hydrate: jest.fn(() => snapshot),
      getSnapshot: jest.fn(() => snapshot),
    };
    offscreen = { ensureReady: jest.fn().mockResolvedValue(undefined) };
    telemetry = {
      initialize: jest.fn().mockResolvedValue(undefined),
      setEnabled: jest.fn(),
      sink: jest.fn(() => undefined),
    };
    perfDebugStore = {
      record: jest.fn(),
      hydrate: jest.fn(),
      setSettings: jest.fn(),
    };
    criticalWork = {
      confirmAnalysisWork: jest.fn().mockResolvedValue(undefined),
      hasWork: jest.fn(() => false),
      sync: jest.fn(),
    };
    startupRecovery = { run: jest.fn().mockResolvedValue(undefined) };
    markSessionHydrated = jest.fn();
    resumePendingFinalization = jest.fn().mockResolvedValue(null);
  });

  const run = () => bootstrapBackground({
    session,
    offscreen,
    telemetry,
    perfDebugStore,
    criticalWork,
    startupRecovery,
    markSessionHydrated,
    resumePendingFinalization,
    logger,
  });

  it('rehydrates a busy session and reconnects the data plane immediately', async () => {
    snapshot = { ...snapshot, phase: 'recording', epoch: 7 };
    session.hydrate.mockReturnValue(snapshot);

    await run();

    expect(telemetry.initialize).toHaveBeenCalledWith(new Set([7]), new Set());
    expect(offscreen.ensureReady).toHaveBeenCalledTimes(1);
    expect(resumePendingFinalization).toHaveBeenCalledTimes(1);
    expect(criticalWork.sync).toHaveBeenCalledTimes(1);
    expect(criticalWork.confirmAnalysisWork).not.toHaveBeenCalled();
    expect(markSessionHydrated).toHaveBeenCalledTimes(1);
    expect(startupRecovery.run).toHaveBeenCalledTimes(1);
  });

  it('discovers detached analysis work for an idle session', async () => {
    criticalWork.hasWork.mockReturnValue(true);

    await run();

    expect(criticalWork.confirmAnalysisWork).toHaveBeenCalledTimes(1);
    expect(criticalWork.sync).toHaveBeenCalledTimes(1);
    expect(offscreen.ensureReady).not.toHaveBeenCalled();
  });

  it('does not re-arm keep-alive from a stale stopping snapshot after buffered idle replay', async () => {
    const hydrated = {
      ...createIdleSession(),
      phase: 'stopping' as const,
      desired: 'idle' as const,
      observed: 'stopping' as const,
      epoch: 7,
    };
    let current = hydrated as RecordingSessionSnapshot;
    session.hydrate.mockReturnValue(hydrated);
    session.getSnapshot.mockImplementation(() => current);
    markSessionHydrated.mockImplementation(() => {
      current = {
        ...createIdleSession(),
        epoch: 7,
      };
    });
    criticalWork = new CriticalWorkCoordinator({
      getSnapshot: () => current,
      hasActiveAnalysisJobs: () => false,
      refreshAnalysisWork: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn(),
      logger,
    });

    await run();

    expect(offscreen.ensureReady).not.toHaveBeenCalled();
    expect(resumePendingFinalization).not.toHaveBeenCalled();
    expect(startKeepAliveMock).not.toHaveBeenCalled();
    expect(stopKeepAliveMock).toHaveBeenCalledTimes(1);
  });

  it('disables telemetry on initialization failure without blocking startup', async () => {
    telemetry.initialize.mockRejectedValue(new Error('telemetry unavailable'));

    await run();

    expect(telemetry.setEnabled).toHaveBeenCalledWith(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Anonymous telemetry initialization failed (non-fatal):',
      expect.any(Error),
    );
    expect(markSessionHydrated).toHaveBeenCalledTimes(1);
    expect(startupRecovery.run).toHaveBeenCalledTimes(1);
  });

  it('fails closed and does not release readiness after a session-storage failure', async () => {
    storageMock.mockRejectedValue(new Error('session storage unavailable'));

    await expect(run()).rejects.toThrow('session storage unavailable');

    expect(markSessionHydrated).not.toHaveBeenCalled();
    expect(startupRecovery.run).not.toHaveBeenCalled();
  });

  it('hydrates perf settings before session observers can use them', async () => {
    await run();

    expect(perfDebugStore.setSettings).toHaveBeenCalledWith(getPerfSettingsSnapshot());
    expect(perfDebugStore.setSettings.mock.invocationCallOrder[0])
      .toBeLessThan(session.hydrate.mock.invocationCallOrder[0]);
  });
});
