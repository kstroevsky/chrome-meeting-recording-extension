describe('background runtime system messages', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({});
  });

  function makeOffscreenInstance() {
    return {
      onStateChanged: undefined as ((msg: any) => void) | undefined,
      onSaveRequested: undefined as ((msg: any) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      closeForUpdate: jest.fn().mockResolvedValue(true),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
      releaseBufferedIngress: jest.fn(),
    };
  }

  async function importBackgroundWith(offscreenInstance: any, driveAuth = { fetchDriveTokenWithFallback: jest.fn() }) {
    jest.doMock('../src/background/drive/driveAuth', () => driveAuth);
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));
    await import('../src/background');
    await new Promise(process.nextTick);
    return (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
  }
  it('dispatches DISCARD_RECORDING through the real background message listener', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      recordingSession: {
        phase: 'recording',
        desired: 'recording',
        observed: 'recording',
        failed: false,
        runConfig: { storageMode: 'drive', micMode: 'separate', recordSelfVideo: true },
        epoch: 3,
        updatedAt: Date.now(),
      },
    });
    const offscreenInstance = makeOffscreenInstance();
    const listener = await importBackgroundWith(offscreenInstance);

    const response = await new Promise<any>((resolve) => {
      listener({ type: 'DISCARD_RECORDING' }, {}, resolve);
    });

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      session: expect.objectContaining({ phase: 'stopping' }),
    }));
    expect(offscreenInstance.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_DISCARD' });
  });

  it('acknowledges a PERF_EVENT without keeping the response channel open', async () => {
    const listener = await importBackgroundWith(makeOffscreenInstance());

    const sendResponse = jest.fn();
    const keepOpen = listener(
      { type: 'PERF_EVENT', entry: { source: 'offscreen', scope: 'runtime', event: 'sample', ts: Date.now(), fields: {} } },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(keepOpen).toBe(false);
  });

  it('surfaces a Drive token failure from GET_DRIVE_TOKEN', async () => {
    const listener = await importBackgroundWith(
      makeOffscreenInstance(),
      { fetchDriveTokenWithFallback: jest.fn().mockResolvedValue({ ok: false, error: 'no token' }) }
    );

    const response = await new Promise<any>((resolve) => {
      listener({ type: 'GET_DRIVE_TOKEN' }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, error: 'no token' });
  });

  it('reports an unexpected GET_DRIVE_TOKEN failure when the auth helper throws', async () => {
    const listener = await importBackgroundWith(
      makeOffscreenInstance(),
      { fetchDriveTokenWithFallback: jest.fn().mockRejectedValue(new Error('network down')) }
    );

    const response = await new Promise<any>((resolve) => {
      listener({ type: 'GET_DRIVE_TOKEN' }, {}, resolve);
    });

    expect(response).toEqual({ ok: false, error: 'network down' });
  });

  it('returns the idle status view for GET_RECORDING_STATUS', async () => {
    const listener = await importBackgroundWith(makeOffscreenInstance());

    const response = await new Promise<any>((resolve) => {
      listener({ type: 'GET_RECORDING_STATUS' }, {}, resolve);
    });

    expect(response.session).toEqual(expect.objectContaining({ phase: 'idle', runConfig: null }));
  });

  it('rejects STOP_RECORDING when no recording session is active', async () => {
    const offscreenInstance = makeOffscreenInstance();
    const listener = await importBackgroundWith(offscreenInstance);

    const response = await new Promise<any>((resolve) => {
      listener({ type: 'STOP_RECORDING' }, {}, resolve);
    });

    expect(response).toEqual(
      expect.objectContaining({ ok: false, error: 'Stop requested but no recording session is active' })
    );
    expect(offscreenInstance.rpc).not.toHaveBeenCalled();
  });
});
