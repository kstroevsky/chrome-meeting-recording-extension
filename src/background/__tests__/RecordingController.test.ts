import { RecordingController } from '../RecordingController';
import { RecordingSession } from '../RecordingSession';
import type { OffscreenManager } from '../OffscreenManager';
import { getPerfSettingsSnapshot } from '../../shared/perf';

jest.mock('../../platform/chrome/tabs', () => ({
  activateTab: jest.fn().mockResolvedValue(undefined),
  getCapturedTabs: jest.fn().mockResolvedValue([]),
  getMediaStreamIdForTab: jest.fn().mockResolvedValue('stream-xyz'),
  getTab: jest.fn().mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij' }),
}));
jest.mock('../../shared/settings', () => ({
  loadRecorderRuntimeSettingsSnapshot: jest.fn().mockResolvedValue({ recorder: 'snapshot' }),
}));

import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../../platform/chrome/tabs';
import { loadRecorderRuntimeSettingsSnapshot } from '../../shared/settings';
import type { RecordingNotationService } from '../RecordingNotationService';

const RUN_CONFIG = { storageMode: 'local', micMode: 'off', recordSelfVideo: false, tabContentType: 'screen' } as const;
const startMsg = (overrides: Record<string, unknown> = {}) => ({
  type: 'START_RECORDING' as const,
  tabId: 42,
  runConfig: { ...RUN_CONFIG },
  ...overrides,
});

describe('RecordingController', () => {
  let session: RecordingSession;
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock; ensureRecorderTabReady: jest.Mock };
  let notations: { list: jest.Mock; add: jest.Mock; endOpen: jest.Mock; removeAll: jest.Mock };
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
    notations = {
      list: jest.fn().mockResolvedValue([]),
      add: jest.fn(async (_id: string, notation: { tStartMs: number; text?: string }) => ({
        id: 'notation:1', tStartMs: notation.tStartMs, text: notation.text ?? '',
      })),
      endOpen: jest.fn(async (_id: string, id: string, tEndMs: number) => ({ id, tStartMs: 0, tEndMs, text: '' })),
      removeAll: jest.fn().mockResolvedValue(undefined),
    };
    const L = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    controller = new RecordingController({
      L,
      offscreen: offscreen as unknown as OffscreenManager,
      session,
      notations: notations as unknown as RecordingNotationService,
    });
  });

  describe('start', () => {
    it('forwards the frozen recorder snapshot on OFFSCREEN_START and leaves the session starting', async () => {
      const result = await controller.start(startMsg());

      expect(getCapturedTabs).toHaveBeenCalledTimes(1);
      expect(loadRecorderRuntimeSettingsSnapshot).toHaveBeenCalledTimes(1);
      expect(offscreen.ensureReady).toHaveBeenCalledTimes(1);
      expect(offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({
        type: 'OFFSCREEN_START',
        streamId: 'stream-xyz',
        meetingSlug: 'meet-abc-defg-hij',
        runConfig: RUN_CONFIG,
        recorderSettings: { recorder: 'snapshot' },
        perfSettings: getPerfSettingsSnapshot(),
        epoch: 1,
      }));
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(session.getSnapshot().phase).toBe('starting');
    });

    it('overrides the snapshot tab content type with the per-recording popup choice', async () => {
      (loadRecorderRuntimeSettingsSnapshot as jest.Mock).mockResolvedValueOnce({
        tab: { output: { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30, contentType: 'screen' } },
      });

      await controller.start(startMsg({ runConfig: { ...RUN_CONFIG, tabContentType: 'video' } }));

      const rpcArg = offscreen.rpc.mock.calls[0][0];
      expect(rpcArg.recorderSettings.tab.output.contentType).toBe('video');
    });

    it('uses a sanitized tab title slug for non-Meet URLs', async () => {
      (getTab as jest.Mock).mockResolvedValue({
        url: 'https://github.com/anthropics/claude-code',
        title: 'anthropics/claude-code: CLI tool · GitHub',
      });

      await controller.start(startMsg());

      const rpcArg = offscreen.rpc.mock.calls[0][0];
      expect(rpcArg.meetingSlug).toBe('anthropics-claude-code-cli-tool-github');
    });

    it('falls back to hostname+path slug when the tab title is missing', async () => {
      (getTab as jest.Mock).mockResolvedValue({
        url: 'https://app.example.com/dashboard',
        title: '',
      });

      await controller.start(startMsg());

      const rpcArg = offscreen.rpc.mock.calls[0][0];
      expect(rpcArg.meetingSlug).toBe('app-example-com-dashboard');
    });

    it('falls back to hostname+path slug when the tab title has no Latin alphanumerics', async () => {
      // A CJK/Cyrillic-only title sanitizes to an empty slug; the host+path keeps
      // the recording meaningfully named instead of degrading to a bare timestamp.
      (getTab as jest.Mock).mockResolvedValue({
        url: 'https://app.example.com/dashboard',
        title: '会議録画',
      });

      await controller.start(startMsg());

      const rpcArg = offscreen.rpc.mock.calls[0][0];
      expect(rpcArg.meetingSlug).toBe('app-example-com-dashboard');
    });

    it('still derives a partial slug from a mixed-script title', async () => {
      (getTab as jest.Mock).mockResolvedValue({
        url: 'https://app.example.com/dashboard',
        title: 'Проект Roadmap 2026',
      });

      await controller.start(startMsg());

      const rpcArg = offscreen.rpc.mock.calls[0][0];
      expect(rpcArg.meetingSlug).toBe('roadmap-2026');
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

  describe('discard', () => {
    it('marks the session stopping and forwards OFFSCREEN_DISCARD without saving', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });

      const result = await controller.discard('popup discard button');

      expect(offscreen.ensureReady).toHaveBeenCalledTimes(1);
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_DISCARD' });
      expect(result).toEqual(expect.objectContaining({ ok: true }));
      expect(session.getSnapshot().phase).toBe('stopping');
    });

    it('drops the discarded run\u2019s notations so they cannot outlive it', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      const historyId = session.getSnapshot().historyId;

      await controller.discard('popup discard button');

      expect(notations.removeAll).toHaveBeenCalledWith(historyId);
    });

    it('still discards when clearing notations fails', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      notations.removeAll.mockRejectedValueOnce(new Error('store closed'));

      await expect(controller.discard()).resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_DISCARD' });
    });

    it('guards against discarding when no recording is active', async () => {
      const result = await controller.discard();

      expect(result).toEqual(
        expect.objectContaining({ ok: false, error: 'Discard requested but no recording session is active' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
      expect(notations.removeAll).not.toHaveBeenCalled();
    });
  });

  describe('notations (ADR-0005)', () => {
    /** Drives the session to a live `recording` phase with a known clock. */
    const record = () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      return session.getSnapshot().historyId!;
    };

    it('stamps a mark at the live recording position, keyed to the run history id', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const historyId = record();
      const startedAt = session.getSnapshot().runningSince!;
      nowSpy.mockReturnValue(startedAt + 7_500);

      const result = await controller.markNotation('  demo starts  ');

      expect(notations.add).toHaveBeenCalledWith(historyId, { tStartMs: 7_500, text: '  demo starts  ' });
      expect(result).toEqual({ ok: true, notation: { id: 'notation:1', tStartMs: 7_500, text: '  demo starts  ' } });
      nowSpy.mockRestore();
    });

    it('marks without text', async () => {
      record();
      await expect(controller.markNotation()).resolves.toMatchObject({ ok: true });
      expect(notations.add).toHaveBeenCalledWith(expect.any(String), { tStartMs: expect.any(Number), text: undefined });
    });

    it('refuses to mark while idle', async () => {
      const result = await controller.markNotation('too early');

      expect(result).toEqual({ ok: false, error: 'Mark requested but no recording is active' });
      expect(notations.add).not.toHaveBeenCalled();
    });

    it('refuses to mark before capture is confirmed or once it is sealing', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      expect(session.getSnapshot().phase).toBe('starting');
      await expect(controller.markNotation()).resolves.toMatchObject({ ok: false });

      session.applyOffscreenPhase({ phase: 'recording' });
      session.markStopping();
      expect(session.getSnapshot().phase).toBe('stopping');
      await expect(controller.markNotation()).resolves.toMatchObject({ ok: false });

      expect(notations.add).not.toHaveBeenCalled();
    });

    it('reports a failed write without failing the recording session', async () => {
      record();
      notations.add.mockRejectedValueOnce(new Error('quota exceeded'));

      const result = await controller.markNotation('x');

      expect(result).toEqual({ ok: false, error: 'MARK_NOTATION failed: quota exceeded' });
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().failed).toBeFalsy();
    });

    it('toggle starts a note when nothing is open', async () => {
      record();
      notations.list.mockResolvedValueOnce([{ id: 'notation:done', tStartMs: 0, tEndMs: 1, text: '' }]);

      const result = await controller.toggleNotation();

      expect(notations.add).toHaveBeenCalledTimes(1);
      expect(notations.endOpen).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true });
    });

    it('toggle ends the open note instead of starting a second one', async () => {
      record();
      notations.list.mockResolvedValueOnce([{ id: 'notation:open', tStartMs: 1_000, text: '' }]);

      await controller.toggleNotation();

      expect(notations.endOpen).toHaveBeenCalledWith(expect.any(String), 'notation:open', expect.any(Number));
      expect(notations.add).not.toHaveBeenCalled();
    });

    it('toggle refuses when nothing is recording', async () => {
      await expect(controller.toggleNotation()).resolves.toEqual({
        ok: false, error: 'Mark requested but no recording is active',
      });
      expect(notations.list).not.toHaveBeenCalled();
    });

    it('closes an open mark at the live position', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const historyId = record();
      const startedAt = session.getSnapshot().runningSince!;
      nowSpy.mockReturnValue(startedAt + 12_000);

      const result = await controller.endNotation('notation:1');

      expect(notations.endOpen).toHaveBeenCalledWith(historyId, 'notation:1', 12_000);
      expect(result).toMatchObject({ ok: true });
      nowSpy.mockRestore();
    });

    it('refuses to close a mark while idle', async () => {
      await expect(controller.endNotation('notation:1')).resolves.toEqual({
        ok: false, error: 'Mark end requested but no recording is active',
      });
      expect(notations.endOpen).not.toHaveBeenCalled();
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
      session.applyOffscreenPhase({ phase: 'recording' });

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
      session.applyOffscreenPhase({ phase: 'recording' });
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
      session.applyOffscreenPhase({ phase: 'recording' });

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
      session.applyOffscreenPhase({ phase: 'recording' });
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'cam boom' });

      const result = await controller.setCameraMuted(true);
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'cam boom' }));
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().cameraMuted).toBeUndefined();
    });
  });

  describe('setInputDevice', () => {
    const startRun = (micMode: 'mixed' | 'separate' | 'off', recordSelfVideo: boolean) => {
      session.start({ storageMode: 'local', micMode, recordSelfVideo }, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
    };

    it('switches the microphone through offscreen and mirrors its new label', async () => {
      startRun('separate', true);
      offscreen.rpc.mockResolvedValueOnce({ ok: true, label: 'AirPods Pro' });

      const result = await controller.setInputDevice('microphone', 'mic-2');

      expect(offscreen.ensureReady).toHaveBeenCalled();
      expect(offscreen.rpc).toHaveBeenCalledWith({
        type: 'OFFSCREEN_SET_INPUT_DEVICE',
        device: 'microphone',
        deviceId: 'mic-2',
      });
      expect(result.ok).toBe(true);
      expect(session.getSnapshot().capturedDevices?.microphone).toBe('AirPods Pro');
    });

    it('switches the camera through the same live-input command', async () => {
      startRun('off', true);
      offscreen.rpc.mockResolvedValueOnce({ ok: true, label: 'FaceTime HD Camera' });

      const result = await controller.setInputDevice('camera', 'cam-2');

      expect(offscreen.rpc).toHaveBeenCalledWith({
        type: 'OFFSCREEN_SET_INPUT_DEVICE',
        device: 'camera',
        deviceId: 'cam-2',
      });
      expect(result.ok).toBe(true);
      expect(session.getSnapshot().capturedDevices?.camera).toBe('FaceTime HD Camera');
    });

    it('rejects unavailable inputs and requests outside the active recording phase', async () => {
      expect(await controller.setInputDevice('microphone', 'mic-2')).toEqual(
        expect.objectContaining({ ok: false, error: 'Input device can only be changed while recording' })
      );
      startRun('off', false);
      expect(await controller.setInputDevice('microphone', 'mic-2')).toEqual(
        expect.objectContaining({ ok: false, error: 'This recording has no microphone' })
      );
      expect(await controller.setInputDevice('camera', 'cam-2')).toEqual(
        expect.objectContaining({ ok: false, error: 'This recording has no camera' })
      );
      expect(offscreen.rpc).not.toHaveBeenCalled();
    });

    it('keeps recording and retains the previous label if switching fails', async () => {
      startRun('mixed', false);
      session.setCapturedDevice('microphone', 'Shure MV7');
      offscreen.rpc.mockResolvedValueOnce({ ok: false, error: 'device disconnected' });

      const result = await controller.setInputDevice('microphone', 'mic-2');

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'device disconnected' }));
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().capturedDevices?.microphone).toBe('Shure MV7');
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
      session.applyOffscreenPhase({ phase: 'recording' });

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
      session.applyOffscreenPhase({ phase: 'recording' });
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'pause boom' });

      const result = await controller.setPaused(true);
      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'pause boom' }));
      expect(session.getSnapshot().phase).toBe('recording');
      expect(session.getSnapshot().paused).toBeUndefined();
    });
  });

  describe('retryUpload', () => {
    it('forwards OFFSCREEN_RETRY_UPLOAD even when idle (uploads are detached)', async () => {
      // No recording active — retry must still reach the offscreen.
      expect(session.getSnapshot().phase).toBe('idle');

      const result = await controller.retryUpload('job-1');

      expect(offscreen.ensureReady).toHaveBeenCalled();
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_RETRY_UPLOAD', jobId: 'job-1' });
      expect(result.ok).toBe(true);
    });

    it('reports failure when the offscreen says the job is no longer retryable', async () => {
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'Upload is no longer retryable' });

      const result = await controller.retryUpload('job-1');

      expect(result).toEqual(expect.objectContaining({ ok: false, error: 'Upload is no longer retryable' }));
    });

    it('reports failure when the retry RPC throws', async () => {
      offscreen.rpc.mockRejectedValue(new Error('port gone'));

      const result = await controller.retryUpload('job-1');

      expect(result).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('RETRY_UPLOAD failed') }));
    });
  });

  describe('cancelUpload', () => {
    it('forwards OFFSCREEN_CANCEL_UPLOAD even when the recorder is idle', async () => {
      const result = await controller.cancelUpload('job-1');

      expect(offscreen.ensureReady).toHaveBeenCalled();
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_CANCEL_UPLOAD', jobId: 'job-1' });
      expect(result.ok).toBe(true);
    });
  });
});
