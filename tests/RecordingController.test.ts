import { RecordingController } from '../src/background/RecordingController';
import { RecordingSession } from '../src/background/RecordingSession';
import type { OffscreenManager } from '../src/background/OffscreenManager';
import { getPerfSettingsSnapshot } from '../src/shared/perf';

jest.mock('../src/platform/chrome/tabs', () => ({
  activateTab: jest.fn().mockResolvedValue(undefined),
  getCapturedTabs: jest.fn().mockResolvedValue([]),
  getMediaStreamIdForTab: jest.fn().mockResolvedValue('stream-xyz'),
  getTab: jest.fn().mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij' }),
}));
jest.mock('../src/shared/settings', () => ({
  loadRecorderRuntimeSettingsSnapshot: jest.fn().mockResolvedValue({ recorder: 'snapshot' }),
}));

import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../src/platform/chrome/tabs';
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
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock; ensureRecorderTabReady: jest.Mock };
  let controller: RecordingController;

  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as any).__E2E_REAL_CAPTURE_TAB__ = false;
    (getCapturedTabs as jest.Mock).mockReset().mockResolvedValue([]);
    (activateTab as jest.Mock).mockReset().mockResolvedValue(undefined);
    (getMediaStreamIdForTab as jest.Mock).mockReset().mockResolvedValue('stream-xyz');
    (getTab as jest.Mock)
      .mockReset()
      .mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij' });
    (loadRecorderRuntimeSettingsSnapshot as jest.Mock)
      .mockReset()
      .mockResolvedValue({ recorder: 'snapshot' });

    session = new RecordingSession(() => {});
    offscreen = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      ensureRecorderTabReady: jest.fn().mockResolvedValue(99),
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
        epoch: 1,
      });
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(session.getSnapshot().phase).toBe('starting');
    });

    it('selects the recorder extension tab before requesting the first stream in live E2E builds', async () => {
      (globalThis as any).__E2E_REAL_CAPTURE_TAB__ = true;
      (getMediaStreamIdForTab as jest.Mock).mockResolvedValue('extension-tab-stream');

      const result = await controller.start(startMsg());

      expect(offscreen.ensureReady).not.toHaveBeenCalled();
      expect(offscreen.ensureRecorderTabReady).toHaveBeenCalledTimes(1);
      expect(getMediaStreamIdForTab).toHaveBeenCalledTimes(1);
      expect(getMediaStreamIdForTab).toHaveBeenCalledWith(42);
      expect(activateTab).toHaveBeenCalledWith(42);
      expect(offscreen.rpc).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'OFFSCREEN_START',
          streamId: 'extension-tab-stream',
        })
      );
      expect(result).toEqual(expect.objectContaining({ ok: true }));
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
      expect(offscreen.ensureRecorderTabReady).not.toHaveBeenCalled();
      expect(session.getSnapshot().phase).toBe('failed');
    });

    it('surfaces recorder failures without changing runtime', async () => {
      offscreen.rpc.mockResolvedValue({
        ok: false,
        error: 'MediaRecorder constructor failed for video/webm',
      });

      const result = await controller.start(startMsg());

      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          error: 'MediaRecorder constructor failed for video/webm',
        })
      );
      expect(offscreen.ensureRecorderTabReady).not.toHaveBeenCalled();
      expect(getMediaStreamIdForTab).toHaveBeenCalledTimes(1);
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

  describe('setMicMuted', () => {
    const startMic = (micMode: 'mixed' | 'separate' | 'off') =>
      session.start({ storageMode: 'local', micMode, recordSelfVideo: false }, { targetTabId: 42 });

    it('rejects when no recording is active', async () => {
      const result = await controller.setMicMuted(true);

      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Mic mute requested but no recording is active' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('rejects when the active recording has no microphone', async () => {
      startMic('off');

      const result = await controller.setMicMuted(true);

      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Mic mute requested but this recording has no microphone' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('forwards OFFSCREEN_SET_MIC_MUTED and mirrors the flag onto the session', async () => {
      startMic('separate');
      session.markRecording();

      const muted = await controller.setMicMuted(true);

      expect(offscreen.ensureReady).toHaveBeenCalled();
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_SET_MIC_MUTED', muted: true });
      expect(muted.ok).toBe(true);
      expect(session.getSnapshot().micMuted).toBe(true);

      offscreen.rpc.mockClear();
      await controller.setMicMuted(false);

      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_SET_MIC_MUTED', muted: false });
      expect(session.getSnapshot().micMuted).toBeUndefined();
    });

    it('leaves the recording intact (not failed) when the offscreen mute fails', async () => {
      startMic('mixed');
      session.markRecording();
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'mute boom' });

      const result = await controller.setMicMuted(true);

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'mute boom' }));
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().micMuted).toBeUndefined();
    });
  });

  describe('setCameraMuted', () => {
    const startRun = (recordSelfVideo: boolean) =>
      session.start({ storageMode: 'local', micMode: 'off', recordSelfVideo }, { targetTabId: 42 });

    it('rejects when no recording is active', async () => {
      const result = await controller.setCameraMuted(true);
      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Camera hide requested but no recording is active' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('rejects when the active recording has no camera', async () => {
      startRun(false);
      const result = await controller.setCameraMuted(true);
      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Camera hide requested but this recording has no camera' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('forwards OFFSCREEN_SET_CAMERA_MUTED and mirrors the flag onto the session', async () => {
      startRun(true);
      session.markRecording();

      const hidden = await controller.setCameraMuted(true);

      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_SET_CAMERA_MUTED', muted: true });
      expect(hidden.ok).toBe(true);
      expect(session.getSnapshot().cameraMuted).toBe(true);

      offscreen.rpc.mockClear();
      await controller.setCameraMuted(false);
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_SET_CAMERA_MUTED', muted: false });
      expect(session.getSnapshot().cameraMuted).toBeUndefined();
    });

    it('leaves the recording intact when the offscreen camera toggle fails', async () => {
      startRun(true);
      session.markRecording();
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'cam boom' });

      const result = await controller.setCameraMuted(true);
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'cam boom' }));
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().cameraMuted).toBeUndefined();
    });
  });

  describe('setPaused', () => {
    const startRun = () =>
      session.start({ storageMode: 'local', micMode: 'off', recordSelfVideo: false }, { targetTabId: 42 });

    it('rejects when no recording is active', async () => {
      const result = await controller.setPaused(true);
      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Pause requested but no recording is active' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('forwards OFFSCREEN_SET_PAUSED and mirrors the flag onto the session (no mic/camera sub-guard)', async () => {
      startRun();
      session.markRecording();

      const paused = await controller.setPaused(true);

      expect(offscreen.ensureReady).toHaveBeenCalled();
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_SET_PAUSED', paused: true });
      expect(paused.ok).toBe(true);
      expect(session.getSnapshot().paused).toBe(true);

      offscreen.rpc.mockClear();
      await controller.setPaused(false);
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_SET_PAUSED', paused: false });
      expect(session.getSnapshot().paused).toBeUndefined();
    });

    it('leaves the recording intact when the offscreen pause fails', async () => {
      startRun();
      session.markRecording();
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'pause boom' });

      const result = await controller.setPaused(true);
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'pause boom' }));
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().paused).toBeUndefined();
    });
  });
});
