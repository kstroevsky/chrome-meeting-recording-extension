describe('background update lifecycle', () => {
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

  function makeOffscreenInstance() {
    return {
      onStateChanged: undefined as ((msg: any) => void) | undefined,
      onSaveRequested: undefined as ((msg: any) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      releaseBufferedIngress: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      closeForUpdate: jest.fn().mockResolvedValue(true),
      hasActiveAnalysisJobs: jest.fn(() => false),
      refreshAnalysisWork: jest.fn().mockResolvedValue(false),
      acknowledgeAnalysisState: jest.fn(),
    };
  }

  function makeDriveLibraryInstance() {
    return {
      artifacts: { resolve: jest.fn() },
      fileRecordingToDestination: jest.fn(),
      renameRootFolder: jest.fn(),
      tidyOnce: jest.fn().mockResolvedValue(undefined),
    };
  }

  async function importBackgroundWith(
    offscreenInstance: any,
    driveAuth = { fetchDriveTokenWithFallback: jest.fn() },
    driveLibraryInstance = makeDriveLibraryInstance(),
  ) {
    jest.doMock('../src/background/drive/driveAuth', () => driveAuth);
    jest.doMock('../src/background/drive/DriveLibraryCoordinator', () => ({
      DriveLibraryCoordinator: jest.fn(() => driveLibraryInstance),
    }));
    jest.doMock('../src/background/offscreen/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => offscreenInstance),
    }));
    await import('../src/background');
    await new Promise(process.nextTick);
    return (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
  }
  it('reloads immediately when an update is available and the session is idle', async () => {
    await importBackgroundWith(makeOffscreenInstance());

    const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
    onUpdate({ version: '2.0.0' });
    await untilCalled(chrome.runtime.reload as jest.Mock);

    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
  });

  describe('updates and topic analysis (ADR-0007 HOST-04)', () => {
    /** A mock whose analysis liveness the test controls. */
    function withAnalysis(initiallyActive: boolean) {
      const offscreenInstance: any = makeOffscreenInstance();
      let active = initiallyActive;
      offscreenInstance.hasActiveAnalysisJobs = jest.fn(() => active);
      offscreenInstance.refreshAnalysisWork = jest.fn(async () => active);
      return { offscreenInstance, setActive: (next: boolean) => { active = next; } };
    }

    /** Drains enough turns for the async update handler to decide. */
    const settle = async () => {
      for (let i = 0; i < 40; i += 1) await new Promise(process.nextTick);
    };

    it('does not reload over a running analysis, even with the session idle', async () => {
      // The P0: the update path checked only recording and uploads, so an idle
      // session reloaded straight over an analysis in the offscreen document.
      const { offscreenInstance } = withAnalysis(true);
      await importBackgroundWith(offscreenInstance);

      const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
      onUpdate({ version: '2.0.0' });
      await settle();

      expect(chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it('applies the deferred reload when the analysis settles, with no session change at all', async () => {
      // An analysis finishing changes nothing in RecordingSession, so a reload
      // waiting only on session transitions would never fire.
      const { offscreenInstance, setActive } = withAnalysis(true);
      await importBackgroundWith(offscreenInstance);

      const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
      onUpdate({ version: '2.0.0' });
      await settle();
      expect(chrome.runtime.reload).not.toHaveBeenCalled();

      setActive(false);
      offscreenInstance.onAnalysisJobChanged?.({
        id: 'ana_1', historyId: 'rec_1', status: 'failed', progress: 0, startedAt: 1, finishedAt: 2,
      });
      await settle();

      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
    });

    it('asks the data plane before reloading, rather than trusting an empty memory', async () => {
      // After a worker restart the in-memory set is empty until the offscreen
      // document replays. The data plane is asked directly, and its answer wins.
      const offscreenInstance: any = makeOffscreenInstance();
      let active = false;
      offscreenInstance.hasActiveAnalysisJobs = jest.fn(() => active);
      offscreenInstance.refreshAnalysisWork = jest.fn(async () => { active = true; return true; });
      await importBackgroundWith(offscreenInstance);
      (chrome.runtime.reload as jest.Mock).mockClear();

      const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
      onUpdate({ version: '2.0.0' });
      await settle();

      expect(offscreenInstance.refreshAnalysisWork).toHaveBeenCalled();
      expect(chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it('defers rather than reloads when the data plane cannot be asked', async () => {
      const offscreenInstance: any = makeOffscreenInstance();
      offscreenInstance.refreshAnalysisWork = jest.fn().mockRejectedValue(new Error('port closed'));
      await importBackgroundWith(offscreenInstance);
      (chrome.runtime.reload as jest.Mock).mockClear();

      const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
      onUpdate({ version: '2.0.0' });
      await settle();

      // Not knowing is not the same as knowing nothing is running.
      expect(chrome.runtime.reload).not.toHaveBeenCalled();
    });

    it('treats an unanswerable data plane as busy, not merely as a deferral', async () => {
      // Deferring on "we could not ask" is only honest if the unknown state is
      // also busy. Otherwise the keep-alive stays off, Chrome unloads the idle
      // worker, and it installs the pending update itself — the outcome the
      // deferral was meant to prevent.
      const offscreenInstance: any = makeOffscreenInstance();
      offscreenInstance.refreshAnalysisWork = jest.fn().mockRejectedValue(new Error('port closed'));
      await importBackgroundWith(offscreenInstance);

      const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
      onUpdate({ version: '2.0.0' });
      await settle();
      (chrome.runtime.reload as jest.Mock).mockClear();

      // An idle session transition must not now conclude that work has finished.
      offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
      await settle();
      expect(chrome.runtime.reload).not.toHaveBeenCalled();

      // Hearing from the data plane at all clears the unknown, and the deferred
      // reload then applies.
      offscreenInstance.hasActiveAnalysisJobs = jest.fn(() => false);
      offscreenInstance.onAnalysisJobChanged?.({
        id: 'ana_1', historyId: 'rec_1', status: 'failed', progress: 0, startedAt: 1, finishedAt: 2,
      });
      await settle();
      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
    });

    it('requests the reload only once, however many things settle at once', async () => {
      const { offscreenInstance, setActive } = withAnalysis(true);
      await importBackgroundWith(offscreenInstance);

      const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
      onUpdate({ version: '2.0.0' });
      await settle();

      setActive(false);
      offscreenInstance.onAnalysisJobChanged?.({
        id: 'ana_1', historyId: 'rec_1', status: 'failed', progress: 0, startedAt: 1, finishedAt: 2,
      });
      offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
      await settle();

      expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
    });
  });

  it('defers the update reload while recording and applies it after work finishes', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ recordingSession: activeSession });
    const offscreenInstance = makeOffscreenInstance();
    await importBackgroundWith(offscreenInstance);

    const onUpdate = (chrome.runtime.onUpdateAvailable.addListener as jest.Mock).mock.calls[0][0];
    onUpdate({ version: '2.0.0' });
    // Let the handler actually decide. This test used to fire `idle` before the
    // handler's microtask ran, so it passed through the reload-immediately
    // branch and never exercised the deferral its name describes.
    for (let i = 0; i < 20; i += 1) await new Promise(process.nextTick);

    // Busy → no immediate reload.
    expect(chrome.runtime.reload).not.toHaveBeenCalled();

    // Recording finishes → offscreen reports idle → deferred reload fires.
    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
    await Promise.resolve();

    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('refreshes the offscreen document when an update installs while idle', async () => {
    const offscreenInstance = makeOffscreenInstance();
    await importBackgroundWith(offscreenInstance);

    const onInstalled = (chrome.runtime.onInstalled.addListener as jest.Mock).mock.calls[0][0];
    await onInstalled({ reason: 'update' });

    expect(offscreenInstance.closeForUpdate).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
  });

  it('finishes durable Drive maintenance before refreshing offscreen on update', async () => {
    const offscreenInstance = makeOffscreenInstance();
    let releaseTidy!: () => void;
    const driveLibrary = makeDriveLibraryInstance();
    driveLibrary.tidyOnce.mockImplementation(() => new Promise<void>((resolve) => {
      releaseTidy = resolve;
    }));
    await importBackgroundWith(
      offscreenInstance,
      { fetchDriveTokenWithFallback: jest.fn() },
      driveLibrary,
    );

    const onInstalled = (chrome.runtime.onInstalled.addListener as jest.Mock).mock.calls[0][0];
    const handling = onInstalled({ reason: 'update' });
    await untilCalled(driveLibrary.tidyOnce);

    expect(offscreenInstance.closeForUpdate).not.toHaveBeenCalled();
    releaseTidy();
    await handling;
    expect(offscreenInstance.closeForUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores onInstalled events that are not updates', async () => {
    const offscreenInstance = makeOffscreenInstance();
    await importBackgroundWith(offscreenInstance);

    const onInstalled = (chrome.runtime.onInstalled.addListener as jest.Mock).mock.calls[0][0];
    await onInstalled({ reason: 'install' });

    expect(offscreenInstance.closeForUpdate).not.toHaveBeenCalled();
  });

  it('defers the reload when an update installs during active work', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({ recordingSession: activeSession });
    const offscreenInstance = makeOffscreenInstance();
    // Busy → closeForUpdate refuses to tear down the offscreen.
    offscreenInstance.closeForUpdate = jest.fn().mockResolvedValue(false);
    await importBackgroundWith(offscreenInstance);

    const onInstalled = (chrome.runtime.onInstalled.addListener as jest.Mock).mock.calls[0][0];
    await onInstalled({ reason: 'update' });

    expect(chrome.runtime.reload).not.toHaveBeenCalled();

    offscreenInstance.onStateChanged?.({ type: 'OFFSCREEN_STATE', phase: 'idle' });
    await Promise.resolve();

    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
  });
});
