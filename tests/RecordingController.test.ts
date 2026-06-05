import { RecordingController } from '../src/background/RecordingController';
import { RecordingSession } from '../src/background/RecordingSession';
import type { OffscreenManager } from '../src/background/OffscreenManager';
import { getPerfSettingsSnapshot } from '../src/shared/perf';

jest.mock('../src/platform/chrome/tabs', () => ({
  getCapturedTabs: jest.fn().mockResolvedValue([]),
  getMediaStreamIdForTab: jest.fn().mockResolvedValue('stream-xyz'),
  getTab: jest.fn().mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij' }),
}));
jest.mock('../src/shared/settings', () => ({
  loadRecorderRuntimeSettingsSnapshot: jest.fn().mockResolvedValue({ recorder: 'snapshot' }),
}));

import { getCapturedTabs, getMediaStreamIdForTab, getTab } from '../src/platform/chrome/tabs';
import { loadRecorderRuntimeSettingsSnapshot } from '../src/shared/settings';

const RUN_CONFIG = { storageMode: 'local', micMode: 'off', recordSelfVideo: false } as const;
const startMsg = (overrides: Record<string, unknown> = {}) => ({
  type: 'START_RECORDING' as const,
  tabId: 42,
  runConfig: { ...RUN_CONFIG },
  ...overrides,
});

describe('RecordingController', () => {
  let session: RecordingSession;
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock };
  let controller: RecordingController;

  beforeEach(() => {
    jest.clearAllMocks();
    (getCapturedTabs as jest.Mock).mockResolvedValue([]);
    (getMediaStreamIdForTab as jest.Mock).mockResolvedValue('stream-xyz');
    (getTab as jest.Mock).mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij' });
    (loadRecorderRuntimeSettingsSnapshot as jest.Mock).mockResolvedValue({ recorder: 'snapshot' });

    session = new RecordingSession(() => {});
    offscreen = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
    };
    const L = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    controller = new RecordingController({
      L,
      offscreen: offscreen as unknown as OffscreenManager,
      session,
    });
  });

  describe('start', () => {
    it('forwards the frozen recorder snapshot on OFFSCREEN_START and leaves the session starting', async () => {
      const result = await controller.start(startMsg());

      expect(getCapturedTabs).toHaveBeenCalledTimes(1);
      expect(loadRecorderRuntimeSettingsSnapshot).toHaveBeenCalledTimes(1);
      expect(offscreen.ensureReady).toHaveBeenCalledTimes(1);
      expect(offscreen.rpc).toHaveBeenCalledWith({
        type: 'OFFSCREEN_START',
        streamId: 'stream-xyz',
        meetingSlug: 'abc-defg-hij',
        runConfig: RUN_CONFIG,
        recorderSettings: { recorder: 'snapshot' },
        perfSettings: getPerfSettingsSnapshot(),
      });
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(session.getSnapshot().phase).toBe('starting');
    });

    it('rejects a non-numeric tabId before touching offscreen or the session', async () => {
      const result = await controller.start(startMsg({ tabId: 'nope' }));

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'Missing tabId' }));
      expect(offscreen.ensureReady).not.toHaveBeenCalled();
      expect(offscreen.rpc).not.toHaveBeenCalled();
      expect(session.getSnapshot().phase).toBe('idle');
    });

    it('rejects an invalid run configuration', async () => {
      const result = await controller.start(startMsg({ runConfig: null }));

      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Missing or invalid run configuration' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
      expect(session.getSnapshot().phase).toBe('idle');
    });

    it('refuses to start when the tab already has an active capture', async () => {
      (getCapturedTabs as jest.Mock).mockResolvedValue([{ tabId: 42, status: 'active' }]);

      const result = await controller.start(startMsg());

      if (result.ok) throw new Error('expected start to fail on capture conflict');
      expect(result.error).toContain('already has an active tab capture');
      expect(offscreen.rpc).not.toHaveBeenCalled();
      expect(session.getSnapshot().phase).toBe('idle');
    });

    it('fails the session when offscreen rejects the start', async () => {
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'boom' });

      const result = await controller.start(startMsg());

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'boom' }));
      expect(session.getSnapshot().phase).toBe('failed');
    });
  });

  describe('stop', () => {
    it('guards against stopping when no recording is active', async () => {
      const result = await controller.stop('popup stop button');

      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Stop requested but no recording session is active' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('marks the session stopping and forwards OFFSCREEN_STOP', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });

      const result = await controller.stop('popup stop button');

      expect(offscreen.ensureReady).toHaveBeenCalledTimes(1);
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP' });
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(session.getSnapshot().phase).toBe('stopping');
    });

    it('fails the session when offscreen rejects the stop', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'stop boom' });

      const result = await controller.stop('popup stop button');

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'stop boom' }));
      expect(session.getSnapshot().phase).toBe('failed');
    });
  });
});
