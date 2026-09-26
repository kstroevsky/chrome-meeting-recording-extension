import { POPUP_TO_BG_MESSAGE_TYPES } from '../../../shared/protocolMessageTypes';
import { RecordingSession } from '../../recording/session/RecordingSession';
import { createMessageListener, POPUP_ROUTE_OWNERS } from '../MessageRouter';

const popup = { url: 'chrome-extension://mock-id/popup.html' } as chrome.runtime.MessageSender;
const meetContentScript = {
  url: 'https://meet.google.com/abc-defg-hij',
  tab: { id: 3 } as chrome.tabs.Tab,
  frameId: 0,
} as chrome.runtime.MessageSender;

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

    expect(listener({ type: 'GET_RECORDING_STATUS' }, popup, sendResponse)).toBe(true);
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
    }, popup, sendResponse)).toBe(true);
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
    }, popup, jest.fn());
    listener({ type: 'GET_RECORDING_STATUS' }, popup, statusResponse);
    listener({ type: 'TRANSCRIPT_UTTERANCES', runId: 1, utterances: [] }, meetContentScript, jest.fn());
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

  it.each([
    ['GET_DRIVE_TOKEN', { type: 'GET_DRIVE_TOKEN' }],
    ['GET_SHARE_IDENTITY_TOKEN', { type: 'GET_SHARE_IDENTITY_TOKEN' }],
    ['REMOVE_RECORDING_HISTORY', { type: 'REMOVE_RECORDING_HISTORY', id: 'rec_1', deleteFiles: true }],
    ['DELETE_INTEGRATION', { type: 'DELETE_INTEGRATION', destinationId: 'dst_1' }],
  ])('refuses %s from a content script in a web page', async (_type, message) => {
    const sendResponse = jest.fn();
    const warn = jest.fn();
    const listener = createMessageListener({
      L: { log: jest.fn(), warn, error: jest.fn() },
      session: new RecordingSession(async () => {}),
      perfDebugStore: { record: jest.fn() } as any,
      controller: {} as any,
    });

    expect(listener(message, meetContentScript, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: 'This request is accepted only from the extension',
    });
    expect(warn).toHaveBeenCalled();
  });
});
