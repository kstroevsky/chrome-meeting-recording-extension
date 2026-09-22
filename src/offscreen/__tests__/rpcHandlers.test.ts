import { wirePortHandlers, wireRuntimeListener } from '../rpcHandlers';
import { buildRecorderRuntimeSettingsSnapshot } from '../../shared/settings';
import type { RecordingPhase } from '../../shared/recording';
import { normalizePerfSettings, PERF_FLAGS, resetPerfFlags } from '../../shared/perf';

function makePort() {
  return {
    onMessage: {
      addListener: jest.fn(),
    },
    postMessage: jest.fn(),
  } as any;
}

/** Builds a handler-deps stub with sensible defaults, plus the wired listener. */
function wire(overrides: Partial<Record<string, any>> = {}) {
  const port = makePort();
  let phase: RecordingPhase = overrides.phase ?? 'idle';
  const engine = overrides.engine ?? {
    startFromStreamId: jest.fn().mockResolvedValue(undefined),
    isRecording: jest.fn().mockReturnValue(true),
    revokeBlobUrl: jest.fn(),
  };
  const deps = {
    engine,
    getPort: () => port,
    connectPort: jest.fn(),
    currentPhase: () => phase,
    currentEpoch: () => overrides.currentEpoch ?? 1,
    isFinalizing: () => overrides.isFinalizing ?? false,
    currentFinalization: () => overrides.currentFinalization ?? null,
    onStartRequested: jest.fn(),
    onStopRequested: jest.fn(),
    onDiscardRequested: jest.fn(),
    retryUpload: overrides.retryUpload ?? jest.fn().mockReturnValue(true),
    cancelUpload: overrides.cancelUpload ?? jest.fn().mockReturnValue(true),
    acknowledgeUploadState: overrides.acknowledgeUploadState ?? jest.fn().mockResolvedValue(undefined),
    analyzeTranscript: overrides.analyzeTranscript,
    listAnalysisWork: overrides.listAnalysisWork,
    cancelAnalysis: overrides.cancelAnalysis,
    acknowledgeAnalysisState: overrides.acknowledgeAnalysisState,
    pushState: jest.fn((next: RecordingPhase) => { phase = next; }),
    clearWarnings: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
  wirePortHandlers(port, deps as any);
  const listener = port.onMessage.addListener.mock.calls[0][0];
  return { port, deps, engine, listener };
}

const validStart = () => ({
  __id: 'start-1',
  type: 'OFFSCREEN_START' as const,
  streamId: 'stream-1',
  meetingSlug: 'abc-defg-hij',
  runConfig: { storageMode: 'local' as const, micMode: 'off' as const, recordSelfVideo: false },
  recorderSettings: buildRecorderRuntimeSettingsSnapshot(),
  perfSettings: normalizePerfSettings({ parallelUploadConcurrency: 2 }),
});

function responseFor(port: any, reqId: string) {
  const call = port.postMessage.mock.calls.find((c: any[]) => c[0]?.__respFor === reqId);
  return call?.[0]?.payload;
}

describe('offscreen rpc handlers', () => {
  afterEach(() => {
    resetPerfFlags();
  });

  it('allows OFFSCREEN_START to retry after a failed start without reloading offscreen', async () => {
    const port = makePort();
    let phase: RecordingPhase = 'failed';
    const engine = {
      startFromStreamId: jest.fn().mockResolvedValue(undefined),
    };
    const deps = {
      engine,
      getPort: () => port,
      connectPort: jest.fn(),
      currentPhase: () => phase,
      currentEpoch: () => 1,
      isFinalizing: () => false,
      currentFinalization: () => null,
      onStartRequested: jest.fn(),
      onStopRequested: jest.fn(),
      onDiscardRequested: jest.fn(),
      acknowledgeUploadState: jest.fn().mockResolvedValue(undefined),
      pushState: jest.fn((nextPhase: RecordingPhase) => { phase = nextPhase; }),
      clearWarnings: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
    };

    wirePortHandlers(port, deps as any);
    const listener = port.onMessage.addListener.mock.calls[0][0];

    await listener({
      __id: 'retry-1',
      type: 'OFFSCREEN_START',
      streamId: 'stream-1',
      meetingSlug: 'abc-defg-hij',
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      recorderSettings: buildRecorderRuntimeSettingsSnapshot(),
      perfSettings: normalizePerfSettings({ parallelUploadConcurrency: 2 }),
    });

    expect(deps.clearWarnings).toHaveBeenCalledTimes(1);
    expect(deps.pushState).toHaveBeenCalledWith('starting');
    expect(engine.startFromStreamId).toHaveBeenCalledWith(
      'stream-1',
      { storageMode: 'local', micMode: 'off', recordSelfVideo: false, tabContentType: 'screen' },
      buildRecorderRuntimeSettingsSnapshot(),
      'abc-defg-hij'
    );
    expect(PERF_FLAGS.parallelUploadConcurrency).toBe(2);
    expect(port.postMessage).toHaveBeenCalledWith({
      __respFor: 'retry-1',
      payload: { ok: true },
    });
  });

  it('registers OFFSCREEN_CONNECT runtime reconnect handling', () => {
    const connectPort = jest.fn();

    wireRuntimeListener(connectPort);
    const calls = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls;
    const listener = calls[calls.length - 1][0];
    const sendResponse = jest.fn();

    const keepChannelOpen = listener({ type: 'OFFSCREEN_CONNECT' }, {}, sendResponse);

    expect(connectPort).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(keepChannelOpen).toBe(true);
  });

  describe('OFFSCREEN_START validation', () => {
    it('rejects a start with a missing streamId before touching the engine', async () => {
      const { port, engine, listener } = wire();
      await listener({ ...validStart(), streamId: undefined });

      expect(responseFor(port, 'start-1')).toEqual({ ok: false, error: 'Missing streamId' });
      expect(engine.startFromStreamId).not.toHaveBeenCalled();
    });

    it('rejects a start with an invalid run configuration', async () => {
      const { port, engine, listener } = wire();
      await listener({ ...validStart(), runConfig: null });

      expect(responseFor(port, 'start-1')).toEqual({ ok: false, error: 'Missing run configuration' });
      expect(engine.startFromStreamId).not.toHaveBeenCalled();
    });

    it('rejects a start with an invalid recorder settings snapshot', async () => {
      const { port, engine, listener } = wire();
      await listener({ ...validStart(), recorderSettings: { tab: { output: { maxFrameRate: 'fast' } } } });

      expect(responseFor(port, 'start-1')).toEqual({
        ok: false,
        error: 'Missing or invalid recorder settings snapshot',
      });
      expect(engine.startFromStreamId).not.toHaveBeenCalled();
    });

    it('rejects a start while the recorder is busy', async () => {
      const { port, engine, listener } = wire({ phase: 'recording' });
      await listener(validStart());

      expect(responseFor(port, 'start-1')).toEqual({ ok: false, error: 'Recorder is busy (recording)' });
      expect(engine.startFromStreamId).not.toHaveBeenCalled();
    });

    it('rejects a start while a previous run is still finalizing', async () => {
      const { port, engine, listener } = wire({ isFinalizing: true });
      await listener(validStart());

      expect(responseFor(port, 'start-1')).toEqual({ ok: false, error: 'Recorder is busy (idle)' });
      expect(engine.startFromStreamId).not.toHaveBeenCalled();
    });

    it('pushes a failed state when the engine throws during start', async () => {
      const engine = {
        startFromStreamId: jest.fn().mockRejectedValue(new Error('capture denied')),
        isRecording: jest.fn().mockReturnValue(true),
        revokeBlobUrl: jest.fn(),
      };
      const { port, deps, listener } = wire({ engine });
      await listener(validStart());

      expect(deps.pushState).toHaveBeenCalledWith('failed', { error: 'Error: capture denied' });
      expect(responseFor(port, 'start-1')).toEqual({ ok: false, error: 'Error: capture denied' });
    });
  });

  describe('OFFSCREEN_STOP', () => {
    it('rejects a stop when the recorder is not active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false) };
      const { port, deps, listener } = wire({ engine });
      await listener({ __id: 'stop-1', type: 'OFFSCREEN_STOP', epoch: 1 });

      expect(responseFor(port, 'stop-1')).toEqual({
        ok: false,
        error: 'Stop requested but recorder is not active',
      });
      expect(deps.onStopRequested).not.toHaveBeenCalled();
    });

    it('marks stopping and requests stop when the recorder is active', async () => {
      const { port, deps, listener } = wire();
      await listener({ __id: 'stop-2', type: 'OFFSCREEN_STOP', epoch: 1 });

      expect(deps.pushState).toHaveBeenCalledWith('stopping');
      expect(deps.onStopRequested).toHaveBeenCalledTimes(1);
      expect(responseFor(port, 'stop-2')).toEqual({ ok: true });
    });

    it('acknowledges the same STOP while that epoch is already finalizing', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false) };
      const { port, deps, listener } = wire({
        engine,
        currentEpoch: 7,
        currentFinalization: { epoch: 7, disposition: 'kept', status: 'running' },
      });

      await listener({ __id: 'stop-restart', type: 'OFFSCREEN_STOP', epoch: 7 });

      expect(responseFor(port, 'stop-restart')).toEqual({ ok: true });
      expect(deps.onStopRequested).not.toHaveBeenCalled();
    });

    it('acknowledges a duplicate STOP after the same epoch already completed', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false) };
      const { port, deps, listener } = wire({
        engine,
        currentEpoch: 7,
        currentFinalization: { epoch: 7, disposition: 'kept', status: 'completed' },
      });

      await listener({ __id: 'stop-complete', type: 'OFFSCREEN_STOP', epoch: 7 });

      expect(responseFor(port, 'stop-complete')).toEqual({ ok: true });
      expect(deps.onStopRequested).not.toHaveBeenCalled();
    });
  });

  describe('OFFSCREEN_DISCARD', () => {
    it('marks stopping and starts the destructive cleanup path when active', async () => {
      const { port, deps, listener } = wire();
      await listener({ __id: 'discard-1', type: 'OFFSCREEN_DISCARD', epoch: 1 });

      expect(deps.pushState).toHaveBeenCalledWith('stopping');
      expect(deps.onDiscardRequested).toHaveBeenCalledTimes(1);
      expect(responseFor(port, 'discard-1')).toEqual({ ok: true });
    });

    it('rejects discard when the recorder is not active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false) };
      const { port, deps, listener } = wire({ engine });
      await listener({ __id: 'discard-2', type: 'OFFSCREEN_DISCARD', epoch: 1 });

      expect(responseFor(port, 'discard-2')).toEqual({
        ok: false,
        error: 'Discard requested but recorder is not active',
      });
      expect(deps.onDiscardRequested).not.toHaveBeenCalled();
    });

    it('acknowledges a duplicate DISCARD while cleanup is already running', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false) };
      const { port, deps, listener } = wire({
        engine,
        currentEpoch: 9,
        currentFinalization: { epoch: 9, disposition: 'discarded', status: 'running' },
      });

      await listener({ __id: 'discard-running', type: 'OFFSCREEN_DISCARD', epoch: 9 });

      expect(responseFor(port, 'discard-running')).toEqual({ ok: true });
      expect(deps.onDiscardRequested).not.toHaveBeenCalled();
    });
  });

  it('rejects stale-epoch STOP and DISCARD commands before touching the recorder', async () => {
    const { port, deps, engine, listener } = wire({ currentEpoch: 12 });

    await listener({ __id: 'stale-stop', type: 'OFFSCREEN_STOP', epoch: 11 });
    await listener({ __id: 'stale-discard', type: 'OFFSCREEN_DISCARD', epoch: 11 });

    expect(responseFor(port, 'stale-stop')).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('Stale finalization command'),
    }));
    expect(responseFor(port, 'stale-discard')).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('Stale finalization command'),
    }));
    expect(engine.isRecording).not.toHaveBeenCalled();
    expect(deps.onStopRequested).not.toHaveBeenCalled();
    expect(deps.onDiscardRequested).not.toHaveBeenCalled();
  });

  it('rejects a conflicting finalization disposition for the same epoch', async () => {
    const { port, deps, listener } = wire({
      currentEpoch: 4,
      currentFinalization: { epoch: 4, disposition: 'kept', status: 'running' },
    });

    await listener({ __id: 'conflict', type: 'OFFSCREEN_DISCARD', epoch: 4 });

    expect(responseFor(port, 'conflict')).toEqual(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('Finalization conflict'),
      finalizationDisposition: 'kept',
    }));
    expect(deps.onDiscardRequested).not.toHaveBeenCalled();
  });

  describe('REVOKE_BLOB_URL (one-way)', () => {
    it('revokes the blob URL and removes the OPFS temp file', async () => {
      const removeEntry = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(global.navigator, 'storage', {
        value: { getDirectory: jest.fn().mockResolvedValue({ removeEntry }) },
        configurable: true,
      });
      const { deps, engine, listener } = wire();

      await listener({ type: 'REVOKE_BLOB_URL', blobUrl: 'blob:abc', opfsFilename: 'tab.webm' });

      expect(engine.revokeBlobUrl).toHaveBeenCalledWith('blob:abc');
      expect(removeEntry).toHaveBeenCalledWith('tab.webm');
      expect(deps.log).toHaveBeenCalledWith('Cleaned up OPFS file', 'tab.webm');
    });

    it('logs an error when OPFS cleanup fails', async () => {
      Object.defineProperty(global.navigator, 'storage', {
        value: { getDirectory: jest.fn().mockRejectedValue(new Error('no opfs')) },
        configurable: true,
      });
      const { deps, listener } = wire();

      await listener({ type: 'REVOKE_BLOB_URL', blobUrl: 'blob:abc', opfsFilename: 'tab.webm' });

      expect(deps.error).toHaveBeenCalledWith('Failed to cleanup OPFS file', expect.stringContaining('no opfs'));
    });
  });

  describe('OFFSCREEN_SET_MIC_MUTED', () => {
    it('rejects a mute request when the recorder is not active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false), setMicMuted: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'mute-1', type: 'OFFSCREEN_SET_MIC_MUTED', muted: true });

      expect(responseFor(port, 'mute-1')).toEqual({
        ok: false,
        error: 'Mic mute requested but recorder is not active',
      });
      expect(engine.setMicMuted).not.toHaveBeenCalled();
    });

    it('mutes the engine when the recorder is active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(true), setMicMuted: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'mute-2', type: 'OFFSCREEN_SET_MIC_MUTED', muted: true });

      expect(engine.setMicMuted).toHaveBeenCalledWith(true);
      expect(responseFor(port, 'mute-2')).toEqual({ ok: true });
    });

    it('coerces a non-boolean muted flag to false', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(true), setMicMuted: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'mute-3', type: 'OFFSCREEN_SET_MIC_MUTED', muted: 'yes' });

      expect(engine.setMicMuted).toHaveBeenCalledWith(false);
      expect(responseFor(port, 'mute-3')).toEqual({ ok: true });
    });
  });

  describe('OFFSCREEN_SET_CAMERA_MUTED', () => {
    it('rejects a camera-hide request when the recorder is not active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false), setCameraMuted: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'cam-1', type: 'OFFSCREEN_SET_CAMERA_MUTED', muted: true });

      expect(responseFor(port, 'cam-1')).toEqual({
        ok: false,
        error: 'Camera hide requested but recorder is not active',
      });
      expect(engine.setCameraMuted).not.toHaveBeenCalled();
    });

    it('hides the camera when the recorder is active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(true), setCameraMuted: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'cam-2', type: 'OFFSCREEN_SET_CAMERA_MUTED', muted: true });

      expect(engine.setCameraMuted).toHaveBeenCalledWith(true);
      expect(responseFor(port, 'cam-2')).toEqual({ ok: true });
    });

    it('coerces a non-boolean muted flag to false', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(true), setCameraMuted: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'cam-3', type: 'OFFSCREEN_SET_CAMERA_MUTED', muted: 1 });

      expect(engine.setCameraMuted).toHaveBeenCalledWith(false);
      expect(responseFor(port, 'cam-3')).toEqual({ ok: true });
    });
  });

  describe('OFFSCREEN_SET_INPUT_DEVICE', () => {
    it('rejects device changes until the engine is fully recording', async () => {
      const engine = {
        getDebugState: jest.fn().mockReturnValue('starting'),
        setInputDevice: jest.fn(),
      };
      const { port, listener } = wire({ engine });

      await listener({
        __id: 'device-1',
        type: 'OFFSCREEN_SET_INPUT_DEVICE',
        device: 'microphone',
        deviceId: 'mic-2',
      });

      expect(responseFor(port, 'device-1')).toEqual({
        ok: false,
        error: 'Input device can only be changed while recording',
      });
      expect(engine.setInputDevice).not.toHaveBeenCalled();
    });

    it('returns the post-switch device label from the engine', async () => {
      const engine = {
        getDebugState: jest.fn().mockReturnValue('recording'),
        setInputDevice: jest.fn().mockResolvedValue('FaceTime HD Camera'),
      };
      const { port, listener } = wire({ engine });

      await listener({
        __id: 'device-2',
        type: 'OFFSCREEN_SET_INPUT_DEVICE',
        device: 'camera',
        deviceId: 'cam-2',
      });

      expect(engine.setInputDevice).toHaveBeenCalledWith('camera', 'cam-2');
      expect(responseFor(port, 'device-2')).toEqual({ ok: true, label: 'FaceTime HD Camera' });
    });

    it('validates the device kind and id before calling the engine', async () => {
      const engine = {
        getDebugState: jest.fn().mockReturnValue('recording'),
        setInputDevice: jest.fn(),
      };
      const { port, listener } = wire({ engine });

      await listener({
        __id: 'device-3',
        type: 'OFFSCREEN_SET_INPUT_DEVICE',
        device: 'speaker',
        deviceId: '',
      });

      expect(responseFor(port, 'device-3')).toEqual({
        ok: false,
        error: 'Missing or invalid input device',
      });
      expect(engine.setInputDevice).not.toHaveBeenCalled();
    });
  });

  describe('OFFSCREEN_SET_PAUSED', () => {
    it('rejects a pause request when the recorder is not active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(false), setPaused: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'pause-1', type: 'OFFSCREEN_SET_PAUSED', paused: true });

      expect(responseFor(port, 'pause-1')).toEqual({
        ok: false,
        error: 'Pause requested but recorder is not active',
      });
      expect(engine.setPaused).not.toHaveBeenCalled();
    });

    it('pauses the engine when the recorder is active', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(true), setPaused: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'pause-2', type: 'OFFSCREEN_SET_PAUSED', paused: true });

      expect(engine.setPaused).toHaveBeenCalledWith(true);
      expect(responseFor(port, 'pause-2')).toEqual({ ok: true });
    });

    it('coerces a non-boolean paused flag to false', async () => {
      const engine = { isRecording: jest.fn().mockReturnValue(true), setPaused: jest.fn() };
      const { port, listener } = wire({ engine });

      await listener({ __id: 'pause-3', type: 'OFFSCREEN_SET_PAUSED', paused: 'yes' });

      expect(engine.setPaused).toHaveBeenCalledWith(false);
      expect(responseFor(port, 'pause-3')).toEqual({ ok: true });
    });
  });

  describe('OFFSCREEN_RETRY_UPLOAD', () => {
    it('retries the job and responds ok when it is still retryable', async () => {
      const retryUpload = jest.fn().mockReturnValue(true);
      const { port, listener } = wire({ retryUpload });

      await listener({ __id: 'retry-1', type: 'OFFSCREEN_RETRY_UPLOAD', jobId: 'job-1' });

      expect(retryUpload).toHaveBeenCalledWith('job-1');
      expect(responseFor(port, 'retry-1')).toEqual({ ok: true });
    });

    it('responds with an error when the job is no longer retryable', async () => {
      const retryUpload = jest.fn().mockReturnValue(false);
      const { port, listener } = wire({ retryUpload });

      await listener({ __id: 'retry-2', type: 'OFFSCREEN_RETRY_UPLOAD', jobId: 'job-1' });

      expect(responseFor(port, 'retry-2')).toEqual({ ok: false, error: 'Upload is no longer retryable' });
    });

    it('rejects a retry with a missing jobId before touching the manager', async () => {
      const retryUpload = jest.fn();
      const { port, listener } = wire({ retryUpload });

      await listener({ __id: 'retry-3', type: 'OFFSCREEN_RETRY_UPLOAD', jobId: undefined });

      expect(responseFor(port, 'retry-3')).toEqual({ ok: false, error: 'Missing jobId' });
      expect(retryUpload).not.toHaveBeenCalled();
    });
  });

  describe('OFFSCREEN_CANCEL_UPLOAD', () => {
    it('cancels the job and responds ok while it is active', async () => {
      const cancelUpload = jest.fn().mockReturnValue(true);
      const { port, listener } = wire({ cancelUpload });

      await listener({ __id: 'cancel-1', type: 'OFFSCREEN_CANCEL_UPLOAD', jobId: 'job-1' });

      expect(cancelUpload).toHaveBeenCalledWith('job-1');
      expect(responseFor(port, 'cancel-1')).toEqual({ ok: true });
    });
  });

  describe('OFFSCREEN_ACK_UPLOAD_STATE (one-way)', () => {
    it('removes a terminal state from the outbox only after the background acknowledges it', async () => {
      const acknowledgeUploadState = jest.fn().mockResolvedValue(undefined);
      const { listener } = wire({ acknowledgeUploadState });

      await listener({ type: 'OFFSCREEN_ACK_UPLOAD_STATE', jobId: 'job-1' });

      expect(acknowledgeUploadState).toHaveBeenCalledWith('job-1');
    });
  });
});

describe('topic analysis commands (ADR-0007)', () => {
  const ANALYSIS_CONFIG = {
    windowUtterances: 4,
    windowStride: 4,
    longPauseMs: 3_000,
    peakNeighbourhood: 2,
    peakMinProminence: 0.05,
    minSegmentMs: 15_000,
    assignmentThreshold: 0.93,
    mergeThreshold: 0.95,
    mergeEverySegments: 12,
    keywordsPerTopic: 4,
  };
  const transcript = [{ tStartMs: 0, tEndMs: 2_000, speaker: 'Ada', text: 'the redis pool is saturated' }];
  const provenance = {
    pipelineVersion: 2,
    embeddingModel: 'Xenova/multilingual-e5-small',
    embeddingModelRevision: 'rev',
    embeddingDimensions: 384,
    embeddingDtype: 'q8',
    configHash: 'abcd1234',
  };

  const analyze = (overrides: Record<string, unknown> = {}) => ({
    __id: 'ana-1',
    type: 'OFFSCREEN_ANALYZE_TRANSCRIPT' as const,
    historyId: 'rec_1',
    transcript,
    config: ANALYSIS_CONFIG,
    provenance,
    ...overrides,
  });

  /** Reads the payload of the response posted for a request id. */
  function replyFor(port: any, reqId: string) {
    const call = port.postMessage.mock.calls.find((c: any[]) => c[0]?.__respFor === reqId);
    return call?.[0]?.payload;
  }

  it('queues a run and answers with the new job id', async () => {
    const analyzeTranscript = jest.fn().mockReturnValue('ana_7');
    const { port, listener } = wire({ analyzeTranscript });

    await listener(analyze());

    expect(analyzeTranscript).toHaveBeenCalledWith('rec_1', transcript, ANALYSIS_CONFIG, provenance);
    expect(replyFor(port, 'ana-1')).toEqual({ ok: true, jobId: 'ana_7' });
  });

  it('answers rather than throws when the run is rejected', async () => {
    const analyzeTranscript = jest.fn(() => {
      throw new Error('A contextual window must be 3–5 utterances (SEG-02), not 9');
    });
    const { port, listener } = wire({ analyzeTranscript });

    await listener(analyze({ config: { ...ANALYSIS_CONFIG, windowUtterances: 9 } }));

    const reply = replyFor(port, 'ana-1');
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('SEG-02');
  });

  it('refuses a malformed request instead of queueing an empty run', async () => {
    const analyzeTranscript = jest.fn();
    const { port, listener } = wire({ analyzeTranscript });

    await listener(analyze({ __id: 'a', historyId: '' }));
    expect(replyFor(port, 'a')).toEqual({ ok: false, error: 'Missing historyId' });

    await listener(analyze({ __id: 'b', transcript: undefined }));
    expect(replyFor(port, 'b')).toEqual({ ok: false, error: 'Missing transcript' });

    await listener(analyze({ __id: 'c', config: undefined }));
    expect(replyFor(port, 'c')).toEqual({ ok: false, error: 'Missing analysis configuration' });

    // A run that could not say what produced it is refused, not defaulted.
    await listener(analyze({ __id: 'd', provenance: undefined }));
    expect(replyFor(port, 'd')).toEqual({ ok: false, error: 'Missing analysis provenance' });

    expect(analyzeTranscript).not.toHaveBeenCalled();
  });

  it('reports analysis as unavailable when the runtime has no manager', async () => {
    const { port, listener } = wire();
    await listener(analyze());
    expect(replyFor(port, 'ana-1')).toEqual({ ok: false, error: 'Topic analysis is unavailable' });
  });

  it('cancels a running job, and says so when there is nothing to cancel', async () => {
    const cancelAnalysis = jest.fn().mockReturnValue(true);
    const { port, listener } = wire({ cancelAnalysis });

    await listener({ __id: 'c1', type: 'OFFSCREEN_CANCEL_ANALYSIS', jobId: 'ana_7' });
    expect(cancelAnalysis).toHaveBeenCalledWith('ana_7');
    expect(replyFor(port, 'c1')).toEqual({ ok: true });

    cancelAnalysis.mockReturnValue(false);
    await listener({ __id: 'c2', type: 'OFFSCREEN_CANCEL_ANALYSIS', jobId: 'ana_7' });
    expect(replyFor(port, 'c2')).toEqual({ ok: false, error: 'Analysis is no longer active' });
  });

  it('releases a held result on acknowledgement', async () => {
    const acknowledgeAnalysisState = jest.fn().mockResolvedValue(undefined);
    const { listener } = wire({ acknowledgeAnalysisState });

    await listener({ type: 'OFFSCREEN_ACK_ANALYSIS_STATE', jobId: 'ana_7' });
    expect(acknowledgeAnalysisState).toHaveBeenCalledWith('ana_7');

    // An empty id would remove nothing and is not worth a storage round-trip.
    await listener({ type: 'OFFSCREEN_ACK_ANALYSIS_STATE', jobId: '' });
    expect(acknowledgeAnalysisState).toHaveBeenCalledTimes(1);
  });

  it('lists every job still keeping the data plane busy', async () => {
    const listAnalysisWork = jest.fn(() => ['ana_running', 'ana_held']);
    const { port, listener } = wire({ listAnalysisWork });

    await listener({ __id: 'w1', type: 'OFFSCREEN_LIST_ANALYSIS_WORK' });
    expect(replyFor(port, 'w1')).toEqual({ ok: true, jobIds: ['ana_running', 'ana_held'] });
  });

  it('answers an empty list, not an error, when the runtime has no manager', async () => {
    // Background asks this to decide whether it may reload; "no manager" is a
    // real answer to that question.
    const { port, listener } = wire();
    await listener({ __id: 'w2', type: 'OFFSCREEN_LIST_ANALYSIS_WORK' });
    expect(replyFor(port, 'w2')).toEqual({ ok: true, jobIds: [] });
  });
});
