import { RecordingController } from '../recording/RecordingController';
import { RecordingSession } from '../recording/session/RecordingSession';
import type { OffscreenManager } from '../offscreen/OffscreenManager';

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
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';


describe('RecordingController', () => {
  let session: RecordingSession;
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock; ensureRecorderTabReady: jest.Mock };
  let notations: { list: jest.Mock; add: jest.Mock; endOpen: jest.Mock; removeAll: jest.Mock };
  let transcripts: any;
  let transcriptCapture: any;
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
    transcripts = { removeAll: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(undefined) };
    transcriptCapture = { flushAtBoundary: jest.fn().mockResolvedValue(undefined) };
    const L = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    controller = new RecordingController({
      L,
      offscreen: offscreen as unknown as OffscreenManager,
      session,
      notations: notations as unknown as RecordingNotationService,
      transcripts: transcripts as never,
      transcriptCapture: transcriptCapture as never,
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

    it('closes the caption buffer on the pause boundary, but not on resume', async () => {
      startRun();
      session.applyOffscreenPhase({ phase: 'recording' });
      const historyId = session.getSnapshot().historyId;

      await controller.setPaused(true);
      expect(transcriptCapture.flushAtBoundary).toHaveBeenCalledWith(historyId);

      transcriptCapture.flushAtBoundary.mockClear();
      await controller.setPaused(false);
      // Resuming opens a new span; there is nothing to close.
      expect(transcriptCapture.flushAtBoundary).not.toHaveBeenCalled();
    });

    it('still pauses when closing the caption buffer fails', async () => {
      startRun();
      session.applyOffscreenPhase({ phase: 'recording' });
      transcriptCapture.flushAtBoundary.mockRejectedValue(new Error('tab is gone'));

      await expect(controller.setPaused(true)).resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(session.getSnapshot().paused).toBe(true);
    });

    it('does not touch the caption buffer when the pause itself failed', async () => {
      startRun();
      session.applyOffscreenPhase({ phase: 'recording' });
      offscreen.rpc.mockResolvedValue({ ok: false, error: 'recorder is gone' });

      await controller.setPaused(true);
      expect(transcriptCapture.flushAtBoundary).not.toHaveBeenCalled();
    });

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

});
