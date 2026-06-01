import { wirePortHandlers, wireRuntimeListener } from '../src/offscreen/rpcHandlers';
import { buildRecorderRuntimeSettingsSnapshot } from '../src/shared/settings';
import type { RecordingPhase } from '../src/shared/recording';

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
});

function responseFor(port: any, reqId: string) {
  const call = port.postMessage.mock.calls.find((c: any[]) => c[0]?.__respFor === reqId);
  return call?.[0]?.payload;
}

describe('offscreen rpc handlers', () => {
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
    });

    expect(deps.clearWarnings).toHaveBeenCalledTimes(1);
    expect(deps.pushState).toHaveBeenCalledWith('starting');
    expect(engine.startFromStreamId).toHaveBeenCalledWith(
      'stream-1',
      { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      buildRecorderRuntimeSettingsSnapshot(),
      'abc-defg-hij'
    );
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
});
