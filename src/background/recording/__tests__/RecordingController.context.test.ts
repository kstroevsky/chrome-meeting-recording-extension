import { RecordingController } from '../RecordingController';
import { RecordingSession } from '../session/RecordingSession';
import type { OffscreenManager } from '../../offscreen/OffscreenManager';

jest.mock('../../../platform/chrome/tabs', () => ({
  activateTab: jest.fn().mockResolvedValue(undefined),
  getCapturedTabs: jest.fn().mockResolvedValue([]),
  getMediaStreamIdForTab: jest.fn().mockResolvedValue('stream-xyz'),
  getTab: jest.fn().mockResolvedValue({
    url: 'https://meet.google.com/abc-defg-hij',
    title: 'Meet',
  }),
  sendTabMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../shared/settings', () => ({
  loadRecorderRuntimeSettingsSnapshot: jest.fn().mockResolvedValue({ recorder: 'snapshot' }),
}));

import { sendTabMessage } from '../../../platform/chrome/tabs';

const RUN_CONFIG = {
  storageMode: 'local',
  micMode: 'off',
  recordSelfVideo: false,
  tabContentType: 'screen',
} as const;

describe('RecordingController recording context lifecycle', () => {
  let session: RecordingSession;
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock };
  let contexts: { begin: jest.Mock; finish: jest.Mock; remove: jest.Mock };
  let controller: RecordingController;

  beforeEach(() => {
    jest.clearAllMocks();
    session = new RecordingSession(() => {});
    contexts = {
      begin: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    offscreen = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
    };
    (sendTabMessage as jest.Mock).mockImplementation(async (_tabId, message) => (
      message?.type === 'GET_MEETING_PROVIDER'
        ? {
            provider: {
              providerId: 'google-meet',
              meetingId: 'abc-defg-hij',
              supportsCaptions: true,
            },
          }
        : undefined
    ));
    controller = new RecordingController({
      L: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      offscreen: offscreen as unknown as OffscreenManager,
      session,
      recordingContexts: contexts as never,
    });
  });

  async function start(): Promise<string> {
    const result = await controller.start({
      type: 'START_RECORDING',
      tabId: 42,
      runConfig: RUN_CONFIG,
    });
    expect(result.ok).toBe(true);
    return session.getSnapshot().historyId!;
  }

  it('persists provider context before starting offscreen capture', async () => {
    const order: string[] = [];
    contexts.begin.mockImplementation(async () => { order.push('context'); });
    offscreen.rpc.mockImplementation(async () => { order.push('offscreen'); return { ok: true }; });

    const historyId = await start();

    expect(contexts.begin).toHaveBeenCalledWith(
      historyId,
      expect.any(Number),
      {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    );
    expect(order).toEqual(['context', 'offscreen']);
  });

  it('removes context when offscreen definitively rejects start', async () => {
    offscreen.rpc.mockResolvedValueOnce({ ok: false, error: 'capture rejected' });

    const result = await controller.start({
      type: 'START_RECORDING',
      tabId: 42,
      runConfig: RUN_CONFIG,
    });
    const historyId = session.getSnapshot().historyId!;

    expect(result.ok).toBe(false);
    expect(contexts.remove).toHaveBeenCalledWith(historyId);
  });

  it('preserves context when offscreen start outcome is ambiguous', async () => {
    offscreen.rpc.mockRejectedValueOnce(new Error('port disconnected'));

    const result = await controller.start({
      type: 'START_RECORDING',
      tabId: 42,
      runConfig: RUN_CONFIG,
    });

    expect(result.ok).toBe(false);
    expect(session.getSnapshot().phase).toBe('starting');
    expect(contexts.remove).not.toHaveBeenCalled();
  });

  it('stamps the end for kept recordings and removes context on discard', async () => {
    const keptId = await start();
    session.applyOffscreenPhase({ phase: 'recording', epoch: session.getSnapshot().epoch });
    await controller.stop();
    expect(contexts.finish).toHaveBeenCalledWith(keptId, expect.any(Number));

    session.applyOffscreenPhase({ phase: 'idle', epoch: session.getSnapshot().epoch });
    const discardedId = await start();
    session.applyOffscreenPhase({ phase: 'recording', epoch: session.getSnapshot().epoch });
    await controller.discard();
    expect(contexts.remove).toHaveBeenCalledWith(discardedId);
  });
});
