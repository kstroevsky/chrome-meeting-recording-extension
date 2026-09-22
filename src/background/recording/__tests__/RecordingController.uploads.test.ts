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
