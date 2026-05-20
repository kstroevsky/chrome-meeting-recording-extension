import { wirePortHandlers, wireRuntimeListener } from '../src/offscreen/rpcHandlers';
import { buildRecorderRuntimeSettingsSnapshot } from '../src/shared/extensionSettings';
import type { RecordingPhase } from '../src/shared/recording';

function makePort() {
  return {
    onMessage: {
      addListener: jest.fn(),
    },
    postMessage: jest.fn(),
  } as any;
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
});
