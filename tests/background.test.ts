describe('background runtime messages', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
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
});
