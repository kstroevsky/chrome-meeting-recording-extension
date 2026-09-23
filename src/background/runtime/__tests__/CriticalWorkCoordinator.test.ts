import { createIdleSession, type RecordingSessionSnapshot } from '../../../shared/recording';
import { CriticalWorkCoordinator } from '../CriticalWorkCoordinator';
import { startKeepAlive, stopKeepAlive } from '../KeepAlive';

jest.mock('../KeepAlive', () => ({
  startKeepAlive: jest.fn(),
  stopKeepAlive: jest.fn(),
}));

const startKeepAliveMock = startKeepAlive as jest.MockedFunction<typeof startKeepAlive>;
const stopKeepAliveMock = stopKeepAlive as jest.MockedFunction<typeof stopKeepAlive>;

describe('CriticalWorkCoordinator', () => {
  const logger = { log: jest.fn(), warn: jest.fn() };
  let snapshot: RecordingSessionSnapshot;
  let activeAnalysis: boolean;
  let refreshAnalysisWork: jest.Mock<Promise<unknown>, []>;
  let reload: jest.Mock;

  beforeEach(() => {
    snapshot = createIdleSession();
    activeAnalysis = false;
    refreshAnalysisWork = jest.fn(async () => activeAnalysis);
    reload = jest.fn();
    logger.log.mockReset();
    logger.warn.mockReset();
    startKeepAliveMock.mockReset();
    stopKeepAliveMock.mockReset();
  });

  const createCoordinator = () => new CriticalWorkCoordinator({
    getSnapshot: () => snapshot,
    hasActiveAnalysisJobs: () => activeAnalysis,
    refreshAnalysisWork,
    reload,
    logger,
  });

  it('defers an update while recording and reloads once the session is idle', async () => {
    snapshot = { ...snapshot, phase: 'recording' };
    const coordinator = createCoordinator();

    await coordinator.applyUpdateWhenSafe();

    expect(reload).not.toHaveBeenCalled();
    expect(startKeepAliveMock).toHaveBeenCalledTimes(1);

    snapshot = { ...snapshot, phase: 'idle' };
    coordinator.sync();

    expect(stopKeepAliveMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('confirms analysis state before reloading an idle worker', async () => {
    const coordinator = createCoordinator();

    await coordinator.applyUpdateWhenSafe();

    expect(refreshAnalysisWork).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('treats an unanswerable analysis data plane as critical work', async () => {
    jest.useFakeTimers();
    refreshAnalysisWork.mockRejectedValue(new Error('offline'));
    const coordinator = createCoordinator();

    await coordinator.applyUpdateWhenSafe();

    expect(coordinator.hasWork()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(startKeepAliveMock).toHaveBeenCalledTimes(1);

    coordinator.markAnalysisWorkKnown();
    coordinator.sync();

    expect(reload).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('treats upload work as critical even while the recording phase is idle', () => {
    snapshot = {
      ...snapshot,
      uploadJobs: [{
        id: 'upload-1',
        historyId: 'history-1',
        label: 'Uploading',
        status: 'uploading',
        progress: 0,
        files: [],
        startedAt: 1,
      }],
    };

    expect(createCoordinator().hasWork()).toBe(true);
  });
});
