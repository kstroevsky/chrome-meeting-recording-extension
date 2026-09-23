import { POPUP_TO_BG_MESSAGE_TYPES } from '../../../shared/protocolMessageTypes';
import { RecordingSession } from '../../recording/session/RecordingSession';
import { createMessageListener, POPUP_ROUTE_OWNERS } from '../MessageRouter';

describe('MessageRouter', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('assigns every recognized popup protocol type to exactly one route owner', () => {
    expect(Object.keys(POPUP_ROUTE_OWNERS).sort()).toEqual(
      [...POPUP_TO_BG_MESSAGE_TYPES].sort(),
    );
  });

  it('does not poison the recording session when readiness fails for a benign request', async () => {
    const session = new RecordingSession(async () => {});
    const fail = jest.spyOn(session, 'fail');
    const sendResponse = jest.fn();
    const listener = createMessageListener({
      L: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      session,
      perfDebugStore: { record: jest.fn() } as any,
      controller: {} as any,
      waitUntilReady: jest.fn().mockRejectedValue(new Error('hydration failed')),
    });

    expect(listener({ type: 'GET_RECORDING_STATUS' }, {}, sendResponse)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fail).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('hydration failed'),
      session: expect.objectContaining({ phase: 'idle' }),
    }));
  });

  it('does not mutate canonical session state when readiness fails for a recording command', async () => {
    const session = new RecordingSession(async () => {});
    const fail = jest.spyOn(session, 'fail');
    const sendResponse = jest.fn();
    const listener = createMessageListener({
      L: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      session,
      perfDebugStore: { record: jest.fn() } as any,
      controller: {} as any,
      waitUntilReady: jest.fn().mockRejectedValue(new Error('hydration failed')),
    });

    expect(listener({
      type: 'START_RECORDING',
      tabId: 7,
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
    }, {}, sendResponse)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fail).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.stringContaining('hydration failed'),
      session: expect.objectContaining({ phase: 'idle' }),
    }));
  });

  it('queues recording, status, and transcript ingress until canonical state is ready', async () => {
    const session = new RecordingSession(async () => {});
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const start = jest.fn(async () => ({
      ok: false,
      error: 'already recording',
      session: { phase: session.getSnapshot().phase },
    }));
    const receive = jest.fn();
    const statusResponse = jest.fn();
    const listener = createMessageListener({
      L: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      session,
      perfDebugStore: { record: jest.fn() } as any,
      controller: { start } as any,
      transcriptCapture: { receive } as any,
      waitUntilReady: () => ready,
    });

    listener({
      type: 'START_RECORDING',
      tabId: 7,
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
    }, {}, jest.fn());
    listener({ type: 'GET_RECORDING_STATUS' }, {}, statusResponse);
    listener({ type: 'TRANSCRIPT_UTTERANCES', runId: 1, utterances: [] }, {}, jest.fn());
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    expect(statusResponse).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    expect(session.getSnapshot().phase).toBe('idle');

    session.start(
      { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      { targetTabId: 7 },
    );
    session.applyOffscreenPhase({ phase: 'recording' });
    releaseReady();
    await Promise.resolve();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledWith(1, []);
    expect(statusResponse).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ phase: 'recording' }),
    }));
  });
});
