import { OffscreenManager } from '../OffscreenManager';
import { getBuildId } from '../../shared/build';

describe('OffscreenManager', () => {
  let manager: OffscreenManager;
  let mockPort: any;

  beforeEach(() => {
    manager = new OffscreenManager();
    mockPort = {
      name: 'offscreen',
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates offscreen document if it does not exist', async () => {
    const createDocumentSpy = jest
      .spyOn(chrome.offscreen, 'createDocument')
      .mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);

    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    onMessageListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await ensureReadyPromise;

    expect(createDocumentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'chrome-extension://mock-id/offscreen.html',
        reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      })
    );
  });

  it('requests a reconnect when an offscreen document exists without a ready port', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(true);

    const ensureReadyPromise = manager.ensureReady();
    await Promise.resolve();
    await Promise.resolve();

    manager.attachPort(mockPort);
    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    onMessageListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await ensureReadyPromise;

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_CONNECT' });
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('recreates a stale offscreen document whose READY reports a mismatched version', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    const createDocumentSpy = jest
      .spyOn(chrome.offscreen, 'createDocument')
      .mockImplementation(async () => {});
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);

    // A stale offscreen (old build) connects and reports an outdated version.
    const staleListener = mockPort.onMessage.addListener.mock.calls[0][0];
    staleListener({ type: 'OFFSCREEN_READY', version: '0.0.1-old' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The manager should have closed the stale doc and created a fresh one,
    // without resolving ensureReady yet.
    expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
    expect(createDocumentSpy).toHaveBeenCalledTimes(2);

    // The fresh document connects and reports the current version → ready resolves.
    const freshPort: any = {
      name: 'offscreen',
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    };
    manager.attachPort(freshPort);
    const freshListener = freshPort.onMessage.addListener.mock.calls[0][0];
    freshListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await expect(ensureReadyPromise).resolves.toBeUndefined();
  });

  it('rejects ensureReady when recreating a stale offscreen fails (no deadlock)', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    jest
      .spyOn(chrome.offscreen, 'createDocument')
      .mockImplementationOnce(async () => {}) // initial create succeeds
      .mockImplementation(async () => { throw new Error('create failed'); }); // recreate fails
    jest.spyOn(chrome.offscreen, 'closeDocument').mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);
    const listener = mockPort.onMessage.addListener.mock.calls[0][0];
    listener({ type: 'OFFSCREEN_READY', version: '0.0.1-old' }); // mismatch → recreate → create throws

    await expect(ensureReadyPromise).rejects.toThrow('create failed');
  });

  it('recreates at most once even if the fresh offscreen also mismatches (no loop)', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    jest.spyOn(chrome.offscreen, 'createDocument').mockImplementation(async () => {});
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);
    const staleListener = mockPort.onMessage.addListener.mock.calls[0][0];
    staleListener({ type: 'OFFSCREEN_READY', version: 'stale-1' }); // mismatch → recreate
    await new Promise((resolve) => setTimeout(resolve, 0));

    const freshPort: any = {
      name: 'offscreen',
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    };
    manager.attachPort(freshPort);
    const freshListener = freshPort.onMessage.addListener.mock.calls[0][0];
    // Even though this id still mismatches, the recreate-once guard accepts it.
    freshListener({ type: 'OFFSCREEN_READY', version: 'stale-2' });

    await expect(ensureReadyPromise).resolves.toBeUndefined();
    expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses to close the offscreen document for update while work is in flight', async () => {
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    manager.hydratePhase('recording');

    await expect(manager.closeForUpdate()).resolves.toBe(false);
    expect(closeDocumentSpy).not.toHaveBeenCalled();
  });

  it('closes the offscreen document for update when idle', async () => {
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    manager.hydratePhase('idle');

    await expect(manager.closeForUpdate()).resolves.toBe(true);
    expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
  });

  it('switches capture work to a ready normal extension tab and returns its consumer tab id', async () => {
    (chrome.tabs.create as jest.Mock).mockResolvedValue({
      id: 99,
      url: 'chrome-extension://mock-id/offscreen.html?runtime=tab',
    });

    const switchPromise = manager.ensureRecorderTabReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-id/offscreen.html?runtime=tab',
      active: true,
    });

    const recorderTabPort: any = {
      name: 'offscreen',
      sender: { tab: { id: 99 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
      disconnect: jest.fn(),
    };
    manager.attachPort(recorderTabPort);
    const onMessageListener = recorderTabPort.onMessage.addListener.mock.calls[0][0];
    onMessageListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await expect(switchPromise).resolves.toBe(99);
  });

  it('closes the recorder runtime tab when discarding idle runtime state for an update', async () => {
    (chrome.tabs.create as jest.Mock).mockResolvedValue({ id: 99 });
    const switchPromise = manager.ensureRecorderTabReady();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const recorderTabPort: any = {
      name: 'offscreen',
      sender: { tab: { id: 99 } },
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
      disconnect: jest.fn(),
    };
    manager.attachPort(recorderTabPort);
    recorderTabPort.onMessage.addListener.mock.calls[0][0]({
      type: 'OFFSCREEN_READY',
      version: getBuildId(),
    });
    await switchPromise;

    manager.hydratePhase('idle');
    await expect(manager.closeForUpdate()).resolves.toBe(true);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(99);
  });

  it('syncs phase updates from offscreen to the badge and listener callback', () => {
    manager.attachPort(mockPort);
    manager.onStateChanged = jest.fn();
    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    const setBadgeTextSpy = jest.spyOn(chrome.action, 'setBadgeText');

    onMessageListener({ type: 'OFFSCREEN_STATE', phase: 'recording' });

    expect(manager.getRecordingStatus()).toBe('recording');
    expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: 'REC' });
    expect(manager.onStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_STATE', phase: 'recording' })
    );
  });

  it('gracefully handles port disconnects', () => {
    manager.attachPort(mockPort);
    expect((manager as any).port).toBe(mockPort);

    const disconnectListener = mockPort.onDisconnect.addListener.mock.calls[0][0];
    disconnectListener();

    expect((manager as any).port).toBe(null);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('forwards blob cleanup requests back to the offscreen port', () => {
    manager.attachPort(mockPort);

    manager.revokeBlobUrl('blob:ok', 'ok.webm');
    manager.revokeBlobUrl('blob:fail');

    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: 'REVOKE_BLOB_URL',
      blobUrl: 'blob:ok',
      opfsFilename: 'ok.webm',
    });
    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: 'REVOKE_BLOB_URL',
      blobUrl: 'blob:fail',
      opfsFilename: undefined,
    });
  });

  describe('background upload jobs (ADR-0004)', () => {
    const job = (id: string, status: string) => ({
      id,
      label: id,
      status,
      progress: status === 'uploading' ? 0.3 : 1,
      files: [],
      startedAt: 1,
    });

    function connect() {
      manager.attachPort(mockPort);
      return mockPort.onMessage.addListener.mock.calls[0][0] as (m: unknown) => void;
    }

    it('forwards upload-state messages to the upload listener', () => {
      const onUploadJobChanged = jest.fn();
      manager.onUploadJobChanged = onUploadJobChanged;
      const listener = connect();

      listener({ type: 'OFFSCREEN_UPLOAD_STATE', job: job('j1', 'uploading') });

      expect(onUploadJobChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'j1', status: 'uploading' }));
    });

    it('stays busy for update while a decoupled upload is in flight, then frees once it settles', async () => {
      const closeDocumentSpy = jest
        .spyOn(chrome.offscreen, 'closeDocument')
        .mockImplementation(async () => {});
      manager.hydratePhase('idle'); // the recording already returned to idle
      const listener = connect();

      listener({ type: 'OFFSCREEN_UPLOAD_STATE', job: job('j1', 'uploading') });
      await expect(manager.closeForUpdate()).resolves.toBe(false);
      expect(closeDocumentSpy).not.toHaveBeenCalled();

      // A terminal report clears the in-flight id, so the update can proceed.
      listener({ type: 'OFFSCREEN_UPLOAD_STATE', job: job('j1', 'completed') });
      await expect(manager.closeForUpdate()).resolves.toBe(true);
      expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('topic analysis jobs (ADR-0007)', () => {
    const analysisJob = (id: string, status: string) => ({
      id,
      historyId: 'rec_1',
      status,
      progress: status === 'analyzing' ? 0.4 : 1,
      startedAt: 1,
    });

    function connect() {
      manager.attachPort(mockPort);
      return mockPort.onMessage.addListener.mock.calls[0][0] as (m: unknown) => void;
    }

    it('forwards analysis state to the analysis listener', () => {
      const onAnalysisJobChanged = jest.fn();
      manager.onAnalysisJobChanged = onAnalysisJobChanged;
      const listener = connect();

      listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', 'analyzing') });

      expect(onAnalysisJobChanged).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', historyId: 'rec_1', status: 'analyzing' }),
      );
    });

    it('forwards a delivered result separately from the state that announced it', () => {
      const onAnalysisResult = jest.fn();
      manager.onAnalysisResult = onAnalysisResult;
      const listener = connect();

      const analysis = { segments: [], topics: [], utteranceCount: 12 };
      const provenance = { pipelineVersion: 2, configHash: 'abcd1234', embeddingDevice: 'wasm' };
      listener({ type: 'OFFSCREEN_ANALYSIS_RESULT', job: analysisJob('a1', 'completed'), analysis, provenance });

      // The provenance the run was enqueued under comes back with it, untouched.
      expect(onAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1' }),
        analysis,
        provenance,
      );
    });

    it('refuses an update while an analysis is running, then frees once it settles (HOST-04)', async () => {
      const closeDocumentSpy = jest
        .spyOn(chrome.offscreen, 'closeDocument')
        .mockImplementation(async () => {});
      manager.hydratePhase('idle'); // analysis outlives the recording phase
      const listener = connect();

      listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', 'analyzing') });
      expect(manager.hasActiveAnalysisJobs()).toBe(true);
      await expect(manager.closeForUpdate()).resolves.toBe(false);
      expect(closeDocumentSpy).not.toHaveBeenCalled();

      // `completed` alone no longer frees it — the acknowledgement does, once
      // background has the result on disk.
      listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', 'completed') });
      expect(manager.hasActiveAnalysisJobs()).toBe(true);
      manager.acknowledgeAnalysisState('a1');
      expect(manager.hasActiveAnalysisJobs()).toBe(false);
      await expect(manager.closeForUpdate()).resolves.toBe(true);
      expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
    });

    it('stays busy after `completed` until the result is acknowledged (HOST-04)', async () => {
      const closeDocumentSpy = jest
        .spyOn(chrome.offscreen, 'closeDocument')
        .mockImplementation(async () => {});
      manager.hydratePhase('idle');
      const listener = connect();

      listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', 'analyzing') });
      listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', 'completed') });

      // The data plane reports `completed` before the result has been delivered
      // and persisted, so tearing the document down here would discard the only
      // copy of the analysis.
      expect(manager.hasActiveAnalysisJobs()).toBe(true);
      await expect(manager.closeForUpdate()).resolves.toBe(false);
      expect(closeDocumentSpy).not.toHaveBeenCalled();

      manager.acknowledgeAnalysisState('a1');
      expect(manager.hasActiveAnalysisJobs()).toBe(false);
      await expect(manager.closeForUpdate()).resolves.toBe(true);
    });

    it('treats a replayed completed job as still-held work', () => {
      manager.hydrateAnalysisJobs([analysisJob('a1', 'completed') as never]);
      expect(manager.hasActiveAnalysisJobs()).toBe(true);

      manager.hydrateAnalysisJobs([analysisJob('a1', 'failed') as never]);
      expect(manager.hasActiveAnalysisJobs()).toBe(false);
    });

    it('frees the update path for every way an analysis can stop', async () => {
      jest.spyOn(chrome.offscreen, 'closeDocument').mockImplementation(async () => {});
      manager.hydratePhase('idle');
      const listener = connect();

      // `completed` is deliberately absent: it is held until acknowledged.
      for (const status of ['failed', 'canceled', 'unsupported']) {
        listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', 'analyzing') });
        expect(manager.hasActiveAnalysisJobs()).toBe(true);
        listener({ type: 'OFFSCREEN_ANALYSIS_STATE', job: analysisJob('a1', status) });
        expect(manager.hasActiveAnalysisJobs()).toBe(false);
      }
    });

    it('seeds liveness from replayed jobs after a reconnect', () => {
      manager.hydrateAnalysisJobs([
        analysisJob('a1', 'analyzing') as never,
        analysisJob('a2', 'failed') as never,
      ]);
      expect(manager.hasActiveAnalysisJobs()).toBe(true);

      manager.hydrateAnalysisJobs([analysisJob('a2', 'failed') as never]);
      expect(manager.hasActiveAnalysisJobs()).toBe(false);
    });

    describe('refreshAnalysisWork', () => {
      it('answers no without creating a document when none exists', async () => {
        const internals = manager as any;
        jest.spyOn(internals, 'hasOffscreenContext').mockResolvedValue(false);
        const ensureReady = jest.spyOn(manager, 'ensureReady');
        manager.hydrateAnalysisJobs([analysisJob('stale', 'analyzing') as never]);

        await expect(manager.refreshAnalysisWork()).resolves.toBe(false);
        // No document means no analysis can exist, so memory is corrected…
        expect(manager.hasActiveAnalysisJobs()).toBe(false);
        // …and nothing is spun up just to ask.
        expect(ensureReady).not.toHaveBeenCalled();
      });

      it('replaces an empty memory with what the data plane reports', async () => {
        // The restart case: nothing replayed yet, but the document is busy.
        const internals = manager as any;
        jest.spyOn(internals, 'hasOffscreenContext').mockResolvedValue(true);
        jest.spyOn(manager, 'ensureReady').mockResolvedValue(undefined);
        const rpc = jest.spyOn(manager, 'rpc').mockResolvedValue({ ok: true, jobIds: ['a1', 'a2'] });

        await expect(manager.refreshAnalysisWork()).resolves.toBe(true);
        expect(rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_LIST_ANALYSIS_WORK' });
        expect(manager.hasActiveAnalysisJobs()).toBe(true);

        // And those jobs clear through the ordinary acknowledgement path.
        manager.acknowledgeAnalysisState('a1');
        manager.acknowledgeAnalysisState('a2');
        expect(manager.hasActiveAnalysisJobs()).toBe(false);
      });

      it('throws rather than guessing when the data plane gives no answer', async () => {
        const internals = manager as any;
        jest.spyOn(internals, 'hasOffscreenContext').mockResolvedValue(true);
        jest.spyOn(manager, 'ensureReady').mockResolvedValue(undefined);
        jest.spyOn(manager, 'rpc').mockResolvedValue({ ok: false, error: 'unknown command' });

        await expect(manager.refreshAnalysisWork()).rejects.toThrow('did not report');
      });
    });

    it('acknowledges without throwing when the port is gone', () => {
      expect(() => manager.acknowledgeAnalysisState('a1')).not.toThrow();
    });
  });
});
