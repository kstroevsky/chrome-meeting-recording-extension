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

  it('still fails canonical session state for a recording command failure', async () => {
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

    expect(fail).toHaveBeenCalledWith(expect.stringContaining('hydration failed'));
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      session: expect.objectContaining({ phase: 'failed' }),
    }));
  });
});
