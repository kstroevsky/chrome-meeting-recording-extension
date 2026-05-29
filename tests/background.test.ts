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

  it('forwards refresh=true on GET_DRIVE_TOKEN to the auth helper', async () => {
    const fetchDriveTokenWithFallback = jest.fn().mockResolvedValue({ ok: true, token: 'fresh-token' });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback,
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
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
        output: { maxWidth: 640, maxHeight: 360, maxFrameRate: 24 },
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
    const loadExtensionSettingsFromStorage = jest.fn().mockResolvedValue({ stored: true });
    const buildRecorderRuntimeSettingsSnapshot = jest.fn().mockReturnValue(recorderSettings);
    const getMediaStreamIdForTab = jest.fn().mockResolvedValue('stream-1');
    const getCapturedTabs = jest.fn().mockResolvedValue([]);
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/shared/extensionSettings', () => ({
      ...jest.requireActual('../src/shared/extensionSettings'),
      loadExtensionSettingsFromStorage,
      buildRecorderRuntimeSettingsSnapshot,
    }));
    jest.doMock('../src/platform/chrome/tabs', () => ({
      ...jest.requireActual('../src/platform/chrome/tabs'),
      getCapturedTabs,
      getMediaStreamIdForTab,
    }));
    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
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

    expect(loadExtensionSettingsFromStorage).toHaveBeenCalledTimes(1);
    expect(buildRecorderRuntimeSettingsSnapshot).toHaveBeenCalledWith({ stored: true });
    expect(offscreenInstance.rpc).toHaveBeenCalledWith({
      type: 'OFFSCREEN_START',
      streamId: 'stream-1',
      meetingSlug: 'abc-defg-hij',
      runConfig: {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      },
      recorderSettings,
    });
    expect(response).toEqual(expect.objectContaining({ ok: true }));
  });

  it('preserves the starting session when offscreen reports its initial idle state during start', async () => {
    const getMediaStreamIdForTab = jest.fn().mockResolvedValue('stream-1');
    const getCapturedTabs = jest.fn().mockResolvedValue([]);
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockImplementation(async () => {
        offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
      }),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/platform/chrome/tabs', () => ({
      ...jest.requireActual('../src/platform/chrome/tabs'),
      getCapturedTabs,
      getMediaStreamIdForTab,
    }));
    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
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
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      }),
    }));
  });

  it('clears diagnostics only after the debug dashboard disconnects while the session is idle', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ recordingSession: activeSession });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const connectListener = (chrome.runtime.onConnect.addListener as jest.Mock).mock.calls[0][0];
    const onDisconnect = { addListener: jest.fn() };
    connectListener({
      name: 'debug-dashboard',
      onDisconnect,
    });

    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();

    const disconnectListener = onDisconnect.addListener.mock.calls[0][0];
    disconnectListener();

    expect(chrome.storage.session.remove).toHaveBeenCalled();
  });

  it('preserves diagnostics when the debug dashboard disconnects before recording ends', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ recordingSession: activeSession });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const connectListener = (chrome.runtime.onConnect.addListener as jest.Mock).mock.calls[0][0];
    const onDisconnect = { addListener: jest.fn() };
    connectListener({
      name: 'debug-dashboard',
      onDisconnect,
    });

    const disconnectListener = onDisconnect.addListener.mock.calls[0][0];
    disconnectListener();

    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });

  it('preserves diagnostics after recording finishes while the debug dashboard is still open', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ recordingSession: activeSession });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const connectListener = (chrome.runtime.onConnect.addListener as jest.Mock).mock.calls[0][0];
    connectListener({
      name: 'debug-dashboard',
      onDisconnect: { addListener: jest.fn() },
    });

    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });

    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });

  it('stops the active recording when the recorded tab is closed', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'abc-defg-hij',
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const removedListener = (chrome.tabs.onRemoved.addListener as jest.Mock).mock.calls[0][0];
    removedListener(42, { windowId: 1, isWindowClosing: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(offscreenInstance.ensureReady).toHaveBeenCalled();
    expect(offscreenInstance.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP' });
  });

  it('stops the active recording when the recorded tab navigates away from the meeting', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'abc-defg-hij',
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const updatedListener = (chrome.tabs.onUpdated.addListener as jest.Mock).mock.calls[0][0];
    updatedListener(42, { url: 'https://example.com/' }, { id: 42 });
    await Promise.resolve();
    await Promise.resolve();

    expect(offscreenInstance.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP' });
  });

  it('ignores meeting-ended messages from a different meeting', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        targetTabId: 42,
        meetingSlug: 'abc-defg-hij',
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
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
        meetingSlug: 'abc-defg-hij',
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = {
      onStateChanged: undefined as ((msg: { type: 'OFFSCREEN_STATE'; phase: 'idle' | 'recording' | 'uploading' }) => void) | undefined,
      onSaveRequested: undefined as ((msg: { type: 'OFFSCREEN_SAVE'; filename: string; blobUrl: string; opfsFilename?: string }) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');
    await new Promise(process.nextTick);

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({ type: 'MEETING_ENDED', meetingId: 'abc-defg-hij', reason: 'post-call state detected' }, { tab: { id: 42 } }, resolve);
    });

    expect(response).toEqual({ ok: true, stopped: true, reason: 'meeting ended: post-call state detected' });
    expect(offscreenInstance.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP' });
  });
});
