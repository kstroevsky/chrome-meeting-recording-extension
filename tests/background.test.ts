describe('background runtime messages', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({});
  });

  it('forwards refresh=true on GET_DRIVE_TOKEN to the auth helper', async () => {
    const fetchDriveTokenWithFallback = jest.fn().mockResolvedValue({ ok: true, token: 'fresh-token' });
    const offscreenInstance = {
      onPhaseChanged: undefined as ((phase: 'idle' | 'recording' | 'uploading') => void) | undefined,
      hydratePhase: jest.fn(),
      setRunConfig: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      getRecordingStatus: jest.fn().mockReturnValue('idle'),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback,
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');

    const listener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    const response = await new Promise<any>((resolve) => {
      listener({ type: 'GET_DRIVE_TOKEN', refresh: true }, {}, resolve);
    });

    expect(fetchDriveTokenWithFallback).toHaveBeenCalledWith({ refresh: true });
    expect(response).toEqual({ ok: true, token: 'fresh-token' });
  });

  it('clears diagnostics only after the debug dashboard disconnects while the session is idle', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ phase: 'recording' });
    const offscreenInstance = {
      onPhaseChanged: undefined as ((phase: 'idle' | 'recording' | 'uploading') => void) | undefined,
      hydratePhase: jest.fn(),
      setRunConfig: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      getRecordingStatus: jest.fn().mockReturnValue('idle'),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');

    const connectListener = (chrome.runtime.onConnect.addListener as jest.Mock).mock.calls[0][0];
    const onDisconnect = { addListener: jest.fn() };
    connectListener({
      name: 'debug-dashboard',
      onDisconnect,
    });

    expect(chrome.storage.session.remove).not.toHaveBeenCalled();

    const disconnectListener = onDisconnect.addListener.mock.calls[0][0];
    disconnectListener();

    expect(chrome.storage.session.remove).toHaveBeenCalled();
  });

  it('preserves diagnostics when the debug dashboard disconnects before recording ends', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ phase: 'recording' });
    const offscreenInstance = {
      onPhaseChanged: undefined as ((phase: 'idle' | 'recording' | 'uploading') => void) | undefined,
      hydratePhase: jest.fn(),
      setRunConfig: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      getRecordingStatus: jest.fn().mockReturnValue('recording'),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');

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
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ phase: 'recording' });
    const offscreenInstance = {
      onPhaseChanged: undefined as ((phase: 'idle' | 'recording' | 'uploading') => void) | undefined,
      hydratePhase: jest.fn(),
      setRunConfig: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn(),
      getRecordingStatus: jest.fn().mockReturnValue('idle'),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn(),
    };

    jest.doMock('../src/background/driveAuth', () => ({
      fetchDriveTokenWithFallback: jest.fn(),
    }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));

    await import('../src/background');

    const connectListener = (chrome.runtime.onConnect.addListener as jest.Mock).mock.calls[0][0];
    connectListener({
      name: 'debug-dashboard',
      onDisconnect: { addListener: jest.fn() },
    });

    offscreenInstance.onPhaseChanged?.('idle');

    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });
});
