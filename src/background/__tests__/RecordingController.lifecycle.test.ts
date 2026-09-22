import { RecordingController } from '../recording/RecordingController';
import { RecordingSession } from '../recording/session/RecordingSession';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
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
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';

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

    it('drains the caption buffer at the cutoff, before the stop reaches offscreen', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      const historyId = session.getSnapshot().historyId;
      const order: string[] = [];
      transcriptCapture.flushAtBoundary.mockImplementation(async () => { order.push('drain'); });
      offscreen.rpc.mockImplementation(async () => { order.push('stop'); return { ok: true }; });

      await controller.stop();

      expect(transcriptCapture.flushAtBoundary).toHaveBeenCalledWith(historyId);
      // Meet keeps refining a caption after the recorder stops; the drain has to
      // happen at the cutoff, not after the pipeline has run on.
      expect(order).toEqual(['drain', 'stop']);
    });

    it('still stops when draining the caption buffer fails', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      session.applyOffscreenPhase({ phase: 'recording' });
      transcriptCapture.flushAtBoundary.mockRejectedValue(new Error('tab is gone'));

      await expect(controller.stop()).resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFSCREEN_STOP' }));
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

    it('drops the discarded run\u2019s transcript so it cannot outlive it', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      const historyId = session.getSnapshot().historyId;

      await controller.discard('popup discard button');

      expect(transcripts.removeAll).toHaveBeenCalledWith(historyId);
    });

    it('still discards when clearing the transcript fails', async () => {
      session.start({ ...RUN_CONFIG }, { targetTabId: 42 });
      transcripts.removeAll.mockRejectedValueOnce(new Error('IndexedDB is unavailable'));

      await expect(controller.discard()).resolves.toEqual(expect.objectContaining({ ok: true }));
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_DISCARD' });
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

});
