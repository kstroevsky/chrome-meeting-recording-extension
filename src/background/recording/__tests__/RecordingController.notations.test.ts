import { RecordingController } from '../RecordingController';
import { RecordingSession } from '../session/RecordingSession';
import type { OffscreenManager } from '../../offscreen/OffscreenManager';

jest.mock('../../../platform/chrome/tabs', () => ({
  activateTab: jest.fn().mockResolvedValue(undefined),
  getCapturedTabs: jest.fn().mockResolvedValue([]),
  getMediaStreamIdForTab: jest.fn().mockResolvedValue('stream-xyz'),
  getTab: jest.fn().mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij' }),
}));
jest.mock('../../../shared/settings', () => ({
  loadRecorderRuntimeSettingsSnapshot: jest.fn().mockResolvedValue({ recorder: 'snapshot' }),
}));

import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../../../platform/chrome/tabs';
import { loadRecorderRuntimeSettingsSnapshot } from '../../../shared/settings';
import type { RecordingNotationService } from '../../library/notations/RecordingNotationService';

const RUN_CONFIG = { storageMode: 'local', micMode: 'off', recordSelfVideo: false, tabContentType: 'screen' } as const;

describe('RecordingController', () => {
  let session: RecordingSession;
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock; ensureRecorderTabReady: jest.Mock };
  let notations: {
    list: jest.Mock;
    add: jest.Mock;
    endOpen: jest.Mock;
    closeOpenSpans: jest.Mock;
    removeAll: jest.Mock;
  };
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
      closeOpenSpans: jest.fn().mockResolvedValue(undefined),
      removeAll: jest.fn().mockResolvedValue(undefined),
    };
    transcripts = { removeAll: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(undefined) };
    transcriptCapture = {
      flushAtBoundary: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
    };
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

    it('exports the run\u2019s notes with the stop, ahead of the media (ADR-0005)', async () => {
      const historyId = record();
      notations.list.mockResolvedValueOnce([
        { id: 'n1', tStartMs: 12_500, tEndMs: 41_000, endedBy: 'user', text: 'Intro / agenda' },
      ]);

      await controller.stop('popup stop button');

      expect(notations.list).toHaveBeenCalledWith(historyId);
      const stopCall = offscreen.rpc.mock.calls.find(([msg]) => msg.type === 'OFFSCREEN_STOP')?.[0];
      expect(stopCall.notesSidecar.vtt).toContain('WEBVTT');
      expect(stopCall.notesSidecar.vtt).toContain('00:00:12.500 --> 00:00:41.000');
      expect(stopCall.notesSidecar.vtt).toContain('Intro / agenda');
    });

    it('stops without a sidecar when the run has no notes', async () => {
      record();
      notations.list.mockResolvedValueOnce([]);

      await controller.stop('popup stop button');

      const stopCall = offscreen.rpc.mock.calls.find(([msg]) => msg.type === 'OFFSCREEN_STOP')?.[0];
      expect(stopCall).toEqual({ type: 'OFFSCREEN_STOP' });
    });

    it('exports the run\u2019s transcript with the stop too (ADR-0007)', async () => {
      const historyId = record();
      notations.list.mockResolvedValueOnce([]);
      transcripts.get.mockResolvedValueOnce({
        source: 'meet-captions',
        segments: [{ tStartMs: 48_000, tEndMs: 52_500, speaker: 'Maria', text: 'Q3 target moved.' }],
      });

      await controller.stop('popup stop button');

      expect(transcripts.get).toHaveBeenCalledWith(historyId);
      const stopCall = offscreen.rpc.mock.calls.find(([msg]) => msg.type === 'OFFSCREEN_STOP')?.[0];
      expect(stopCall.transcriptSidecar.vtt).toContain('WEBVTT');
      expect(stopCall.transcriptSidecar.vtt).toContain('00:00:48.000 --> 00:00:52.500');
      expect(stopCall.transcriptSidecar.vtt).toContain('<v Maria>Q3 target moved.');
    });

    it('still stops when the transcript cannot be read', async () => {
      record();
      notations.list.mockResolvedValueOnce([]);
      transcripts.get.mockRejectedValueOnce(new Error('IndexedDB is unavailable'));

      await controller.stop('popup stop button');

      const stopCall = offscreen.rpc.mock.calls.find(([msg]) => msg.type === 'OFFSCREEN_STOP')?.[0];
      expect(stopCall).toEqual({ type: 'OFFSCREEN_STOP' });
    });

    it('still stops when the notes cannot be read', async () => {
      record();
      notations.list.mockRejectedValueOnce(new Error('store closed'));

      await expect(controller.stop('popup stop button')).resolves.toMatchObject({ ok: true });
      expect(offscreen.rpc).toHaveBeenCalledWith({ type: 'OFFSCREEN_STOP' });
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

});
