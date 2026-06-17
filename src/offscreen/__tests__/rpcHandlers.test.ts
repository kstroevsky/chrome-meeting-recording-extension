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
    isFinalizing: () => overrides.isFinalizing ?? false,
    onStartRequested: jest.fn(),
    onStopRequested: jest.fn(),
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
      isFinalizing: () => false,
      onStartRequested: jest.fn(),
      onStopRequested: jest.fn(),
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
      { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
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
      await listener({ __id: 'stop-1', type: 'OFFSCREEN_STOP' });

      expect(responseFor(port, 'stop-1')).toEqual({
        ok: false,
        error: 'Stop requested but recorder is not active',
      });
      expect(deps.onStopRequested).not.toHaveBeenCalled();
    });

    it('marks stopping and requests stop when the recorder is active', async () => {
      const { port, deps, listener } = wire();
      await listener({ __id: 'stop-2', type: 'OFFSCREEN_STOP' });

      expect(deps.pushState).toHaveBeenCalledWith('stopping');
      expect(deps.onStopRequested).toHaveBeenCalledTimes(1);
      expect(responseFor(port, 'stop-2')).toEqual({ ok: true });
    });
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
});
