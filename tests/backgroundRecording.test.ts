import { TIMEOUTS } from '../src/shared/timeouts';
import { DEFAULT_DRIVE_ROOT_FOLDER_NAME } from '../src/shared/settings';
import { PERF_DEBUG_SNAPSHOT_STORAGE_KEY } from '../src/shared/perf';

describe('background runtime messages', () => {
  const activeSession = {
    phase: 'recording',
    runConfig: null,
    updatedAt: Date.now(),
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({});
  });

  /** Waits for a mock to be called, letting queued microtasks and IDB reads settle. */
  async function untilCalled(mock: jest.Mock, attempts = 40): Promise<void> {
    for (let i = 0; i < attempts && mock.mock.calls.length === 0; i++) {
      await new Promise(process.nextTick);
    }
  }

  it('forwards refresh=true on GET_DRIVE_TOKEN to the auth helper', async () => {
    const fetchDriveTokenWithFallback = jest.fn().mockResolvedValue({ ok: true, token: 'fresh-token' });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback,
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({ type: 'GET_DRIVE_TOKEN', refresh: true }, {}, resolve);
    });

    expect(fetchDriveTokenWithFallback).toHaveBeenCalledWith({ refresh: true });
    expect(response).toEqual({ ok: true, token: 'fresh-token' });
  });

  it('loads and forwards the frozen recorder settings snapshot on START_RECORDING', async () => {
    const recorderSettings = {
      tab: {
        output: { maxWidth: 640, maxHeight: 360, maxFrameRate: 24, videoBitsPerSecond: 600_000 },
      },
      selfVideo: {
        profile: {
          width: 1280,
          height: 720,
          frameRate: 24,
          aspectRatio: 16 / 9,
          defaultBitsPerSecond: 2_000_000,
          minAdaptiveBitsPerSecond: 1_000_000,
        },
      },
      microphone: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      },
      chunking: {
        defaultTimesliceMs: 1500,
        extendedTimesliceMs: 4500,
      },
    };
    const loadRecorderRuntimeSettingsSnapshot = jest.fn().mockResolvedValue(recorderSettings);
    const getMediaStreamIdForTab = jest.fn().mockResolvedValue('stream-1');
    const getCapturedTabs = jest.fn().mockResolvedValue([]);
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/shared/settings', () => ({
      ...jest.requireActual('../src/shared/settings'),
      loadRecorderRuntimeSettingsSnapshot,
    }));
    jest.doMock('../src/platform/chrome/tabs', () => ({
      ...jest.requireActual('../src/platform/chrome/tabs'),
      getCapturedTabs,
      getMediaStreamIdForTab,
    }));
    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({
        type: 'START_RECORDING',
        tabId: 42,
        runConfig: {
          storageMode: 'local',
          micMode: 'off',
          recordSelfVideo: false,
        },
      }, {}, resolve);
    });

    expect(loadRecorderRuntimeSettingsSnapshot).toHaveBeenCalledTimes(1);
    expect(offscreenInstance.rpc).toHaveBeenCalledWith(expect.objectContaining({
      type: 'OFFSCREEN_START',
      streamId: 'stream-1',
      meetingSlug: 'meet-abc-defg-hij',
      runConfig: {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
        tabContentType: 'screen',
      },
      recorderSettings,
      perfSettings: expect.objectContaining({
        parallelUploadConcurrency: 2,
      }),
      epoch: 1,
    }));
    expect(response).toEqual(expect.objectContaining({ ok: true }));
  });

  it('preserves the starting session when offscreen reports its initial idle state during start', async () => {
    const getMediaStreamIdForTab = jest.fn().mockResolvedValue('stream-1');
    const getCapturedTabs = jest.fn().mockResolvedValue([]);
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockImplementation(async () => {
        offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
      }),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/platform/chrome/tabs', () => ({
      ...jest.requireActual('../src/platform/chrome/tabs'),
      getCapturedTabs,
      getMediaStreamIdForTab,
    }));
    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({
        type: 'START_RECORDING',
        tabId: 42,
        runConfig: {
          storageMode: 'local',
          micMode: 'off',
          recordSelfVideo: false,
        },
      }, {}, resolve);
    });

    // The wire response carries the popup-facing status view, which intentionally
    // drops control-plane bookkeeping (targetTabId/meetingSlug) the popup never renders.
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      session: expect.objectContaining({
        phase: 'starting',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false, tabContentType: 'screen' },
      }),
    }));
  });

  it('epoch fence applies matching-run status and drops stale-run status', async () => {
    // Rehydrated mid-stop (desired=idle, observed=stopping) so an applied status
    // moves the derived phase coherently and a dropped one leaves it unchanged.
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'stopping',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        epoch: 1,
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: any) => void) | undefined,
      onSaveRequested: undefined as ((msg: any) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({ fetchDriveTokenWithFallback: jest.fn() }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const phase = async () =>
      (await new Promise<any>((resolve) => listener({ type: 'GET_RECORDING_STATUS' }, {}, resolve))).session.phase;

    // Matching the current run's epoch → applied (a same-run idle ends the run).
    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle', epoch: 1 });
    expect(await phase()).toBe('idle');

    // A stale update from a previous run (wrong epoch) → dropped; phase unchanged.
    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'recording', epoch: 99 });
    expect(await phase()).toBe('idle');
  });

  it('start watchdog fails and tears down a session left orphaned in starting past the budget', async () => {
    jest.useFakeTimers();
    // Keep-alive (armed for the busy `starting` phase) pokes the runtime on its
    // interval; stub it so advancing fake time doesn't throw on the chrome mock.
    (chrome.runtime as any).getPlatformInfo = jest.fn();
    try {
      // A persisted `starting` rehydrated on service-worker restart with nothing
      // driving it forward — the orphan the watchdog (ADR-0003) exists to rescue.
      (chrome.storage.session.get as jest.Mock).mockResolvedValue({
        recordingSession: {
          phase: 'starting',
          runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
          epoch: 1,
          updatedAt: Date.now(),
        },
      });
      const offscreenInstance = {
        onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
        onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
        hydratePhase: jest.fn(),
        attachPort: jest.fn(),
        ensureReady: jest.fn().mockResolvedValue(undefined),
        stopIfPossibleOnSuspend: jest.fn(),
        rpc: jest.fn(),
        revokeBlobUrl: jest.fn(),
        releaseBufferedIngress: jest.fn(),
        closeForUpdate: jest.fn().mockResolvedValue(true),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      };

      jest.doMock('../src/background/drive/driveAuth', () => ({ fetchDriveTokenWithFallback: jest.fn() }));
      jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
        OffscreenManager: jest.fn(() => offscreenInstance),
      }));

      await import('../src/background');
      // Flush the hydrate IIFE so the watchdog arms on the rehydrated `starting`.
      await jest.advanceTimersByTimeAsync(0);
      expect(offscreenInstance.closeForUpdate).not.toHaveBeenCalled(); // still within budget

      // Cross the budget → watchdog fires → fail + tear down the stale offscreen.
      await jest.advanceTimersByTimeAsync(TIMEOUTS.STARTING_WATCHDOG_MS + 100);
      expect(offscreenInstance.closeForUpdate).toHaveBeenCalledTimes(1);

      const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
      const status = await new Promise<any>((resolve) => {
        listener({ type: 'GET_RECORDING_STATUS' }, {}, resolve);
      });
      expect(status.session.phase).toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('stop watchdog fails and tears down a session left orphaned in stopping past the budget', async () => {
    jest.useFakeTimers();
    (chrome.runtime as any).getPlatformInfo = jest.fn();
    try {
      // The symmetric twin of the start orphan: the worker died mid-stop (after
      // markStopping persisted `stopping`, before OFFSCREEN_STOP resolved) and the
      // offscreen is also gone, so nothing drives the rehydrated `stopping` on.
      (chrome.storage.session.get as jest.Mock).mockResolvedValue({
        recordingSession: {
          phase: 'stopping',
          runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
          epoch: 1,
          updatedAt: Date.now(),
        },
      });
      const offscreenInstance = {
        onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
        onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
        hydratePhase: jest.fn(),
        attachPort: jest.fn(),
        ensureReady: jest.fn().mockResolvedValue(undefined),
        stopIfPossibleOnSuspend: jest.fn(),
        rpc: jest.fn(),
        revokeBlobUrl: jest.fn(),
        releaseBufferedIngress: jest.fn(),
        closeForUpdate: jest.fn().mockResolvedValue(true),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      };

      jest.doMock('../src/background/drive/driveAuth', () => ({ fetchDriveTokenWithFallback: jest.fn() }));
      jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
        OffscreenManager: jest.fn(() => offscreenInstance),
      }));

      await import('../src/background');
      await jest.advanceTimersByTimeAsync(0);
      expect(offscreenInstance.closeForUpdate).not.toHaveBeenCalled(); // still within budget

      await jest.advanceTimersByTimeAsync(TIMEOUTS.STOPPING_WATCHDOG_MS + 100);
      expect(offscreenInstance.closeForUpdate).toHaveBeenCalledTimes(1);

      const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
      const status = await new Promise<any>((resolve) => {
        listener({ type: 'GET_RECORDING_STATUS' }, {}, resolve);
      });
      expect(status.session.phase).toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps diagnostics after a recording finishes so they can be exported later (no clear-on-idle)', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ recordingSession: activeSession });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    (chrome.storage.session.remove as jest.Mock).mockClear();
    // Recording finishes -> idle. Under the clear-on-start policy this must NOT
    // wipe diagnostics, so they survive until the next recording begins and can be
    // opened/exported after the fact even if the dashboard was never open during it.
    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
    await new Promise(process.nextTick);

    expect(chrome.storage.session.remove).not.toHaveBeenCalledWith(PERF_DEBUG_SNAPSHOT_STORAGE_KEY);
  });

  it('stops the active recording when the recorded tab is closed', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'meet-abc-defg-hij',
        epoch: 3,
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const removedListener = (chrome.tabs.onRemoved.addListener as jest.Mock).mock.calls[0][0];
    removedListener(42, { windowId: 1, isWindowClosing: false });
    await untilCalled(offscreenInstance.rpc);

    expect(offscreenInstance.ensureReady).toHaveBeenCalled();
    expect(offscreenInstance.rpc)
      .toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP', epoch: 3, driveRootFolderName: DEFAULT_DRIVE_ROOT_FOLDER_NAME });
  });

  it('stops the active recording when the recorded tab navigates away from the meeting', async () => {
    const { PlaybackLeaseManager } = await import('../src/background/playback/PlaybackLeaseManager');
    const { DrivePlaybackAuthLeaseManager } = await import('../src/background/playback/DrivePlaybackAuthLeaseManager');
    const releasePlaybackTab = jest
      .spyOn(PlaybackLeaseManager.prototype, 'releaseTab')
      .mockResolvedValue(0);
    const releaseDriveTab = jest
      .spyOn(DrivePlaybackAuthLeaseManager.prototype, 'releaseTab')
      .mockResolvedValue(undefined);
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'meet-abc-defg-hij',
        epoch: 3,
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const updatedListeners = (chrome.tabs.onUpdated.addListener as jest.Mock).mock.calls
      .map(([listener]) => listener as (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void);
    expect(updatedListeners).toHaveLength(2);
    updatedListeners.forEach((listener) => listener(42, { url: 'https://example.com/' }, { id: 42 } as chrome.tabs.Tab));
    await untilCalled(offscreenInstance.rpc);
    await new Promise(process.nextTick);

    expect(offscreenInstance.rpc)
      .toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP', epoch: 3, driveRootFolderName: DEFAULT_DRIVE_ROOT_FOLDER_NAME });
    expect(releasePlaybackTab).toHaveBeenCalledWith(42);
    expect(releaseDriveTab).toHaveBeenCalledWith(42);

    releasePlaybackTab.mockClear();
    releaseDriveTab.mockClear();
    updatedListeners.forEach((listener) => listener(42, { status: 'complete' }, { id: 42 } as chrome.tabs.Tab));
    await new Promise(process.nextTick);

    expect(releasePlaybackTab).not.toHaveBeenCalled();
    expect(releaseDriveTab).not.toHaveBeenCalled();
  });

  it('ignores meeting-ended messages from a different meeting', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'meet-abc-defg-hij',
        epoch: 3,
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({ type: 'MEETING_ENDED', meetingId: 'other-meet', reason: 'post-call state detected' }, { tab: { id: 42 } }, resolve);
    });

    expect(response).toEqual({ ok: true, stopped: false, reason: 'meeting-mismatch' });
    expect(offscreenInstance.rpc).not.toHaveBeenCalled();
  });

  it('stops only when the meeting-ended message matches the recorded tab and meeting', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'meet-abc-defg-hij',
        epoch: 3,
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'stopping' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };

    jest.doMock('../src/background/drive/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({ type: 'MEETING_ENDED', meetingId: 'abc-defg-hij', reason: 'post-call state detected' }, { tab: { id: 42 } }, resolve);
    });

    expect(response).toEqual({ ok: true, stopped: true, reason: 'meeting ended: post-call state detected' });
    expect(offscreenInstance.rpc)
      .toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP', epoch: 3, driveRootFolderName: DEFAULT_DRIVE_ROOT_FOLDER_NAME });
  });

});
