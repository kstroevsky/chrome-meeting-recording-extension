jest.mock('../../platform/chrome/downloads', () => ({
  downloadFile: jest.fn().mockResolvedValue(1),
  awaitDownloadSettled: jest.fn().mockResolvedValue('complete'),
}));
jest.mock('../../platform/chrome/runtime', () => ({
  pokeRuntime: jest.fn(),
}));
jest.mock('../../shared/messages', () => ({
  broadcastToPopup: jest.fn().mockResolvedValue(undefined),
}));

import {
  isFreshRecordingStart,
  registerSaveHandler,
  startKeepAlive,
  stopKeepAlive,
} from '../sessionLifecycle';
import { awaitDownloadSettled, downloadFile } from '../../platform/chrome/downloads';
import { pokeRuntime } from '../../platform/chrome/runtime';
import { broadcastToPopup } from '../../shared/messages';

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('registerSaveHandler', () => {
  let offscreen: any;
  let L: { log: jest.Mock; warn: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    (awaitDownloadSettled as jest.Mock).mockResolvedValue('complete');
    offscreen = { onSaveRequested: undefined, revokeBlobUrl: jest.fn() };
    L = { log: jest.fn(), warn: jest.fn() };
    registerSaveHandler(offscreen, L);
  });

  it('downloads the file, broadcasts success, then cleans up OPFS once the download completes', async () => {
    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1', opfsFilename: 'tab.webm' });
    await flushMicrotasks();

    expect(downloadFile).toHaveBeenCalledWith({ url: 'blob:1', filename: 'tab.webm', saveAs: false });
    expect(broadcastToPopup).toHaveBeenCalledWith({ type: 'RECORDING_SAVED', filename: 'tab.webm' });
    // Cleanup is gated on the real download completion, not a blind timer.
    expect(awaitDownloadSettled).toHaveBeenCalledWith(1);
    expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1', 'tab.webm');
  });

  it('keeps the OPFS file (revokes URL only) when the download is interrupted', async () => {
    (awaitDownloadSettled as jest.Mock).mockResolvedValueOnce('interrupted');

    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1', opfsFilename: 'tab.webm' });
    await flushMicrotasks();

    expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1');
    expect(offscreen.revokeBlobUrl).not.toHaveBeenCalledWith('blob:1', 'tab.webm');
  });

  it('leaves the URL and OPFS file untouched when the download never settles', async () => {
    (awaitDownloadSettled as jest.Mock).mockResolvedValueOnce('timeout');

    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1', opfsFilename: 'tab.webm' });
    await flushMicrotasks();

    expect(offscreen.revokeBlobUrl).not.toHaveBeenCalled();
  });

  it('broadcasts a save error and keeps the OPFS file when the download never starts', async () => {
    (downloadFile as jest.Mock).mockRejectedValueOnce(new Error('Download blocked'));

    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1', opfsFilename: 'tab.webm' });
    await flushMicrotasks();

    expect(L.warn).toHaveBeenCalledWith('downloads.download error:', 'Download blocked');
    expect(broadcastToPopup).toHaveBeenCalledWith({
      type: 'RECORDING_SAVE_ERROR',
      filename: 'tab.webm',
      error: 'Download blocked',
    });
    // No download to wait on; free the URL but preserve the OPFS source for recovery.
    expect(awaitDownloadSettled).not.toHaveBeenCalled();
    expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1');
  });

  it('stringifies a non-Error download rejection', async () => {
    (downloadFile as jest.Mock).mockRejectedValueOnce('plain failure');

    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1' });
    await flushMicrotasks();

    expect(L.warn).toHaveBeenCalledWith('downloads.download error:', 'plain failure');
    expect(broadcastToPopup).toHaveBeenCalledWith({
      type: 'RECORDING_SAVE_ERROR',
      filename: 'tab.webm',
      error: 'plain failure',
    });
  });

  it('synthesizes a fallback filename when none is provided', async () => {
    offscreen.onSaveRequested({ filename: '   ', blobUrl: 'blob:1' });
    await flushMicrotasks();

    const downloadArg = (downloadFile as jest.Mock).mock.calls[0][0];
    expect(downloadArg.filename).toMatch(/^google-meet-.*recording\.webm$/);
  });

  it('does nothing when no blobUrl is present', async () => {
    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: '' });
    await flushMicrotasks();

    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('creates the history row before starting a download that can settle immediately', async () => {
    let releaseHistory!: () => void;
    const history = {
      createPending: jest.fn(() => new Promise<void>((resolve) => { releaseHistory = resolve; })),
      localSaveSettled: jest.fn().mockResolvedValue(undefined),
      setDuration: jest.fn().mockResolvedValue(undefined),
      recordArtifactLocation: jest.fn().mockResolvedValue(undefined),
    };
    registerSaveHandler(offscreen, L, history);

    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', filename: 'tab.webm', blobUrl: 'blob:1' });
    await Promise.resolve();
    expect(history.createPending).toHaveBeenCalledWith(
      'recording:1',
      [{ id: 'recording:1:tab', stream: 'tab', filename: 'tab.webm' }],
      'local',
    );
    expect(downloadFile).not.toHaveBeenCalled();

    releaseHistory();
    await flushMicrotasks();

    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(history.localSaveSettled).toHaveBeenCalledWith('recording:1', 'tab', 1, 'complete', undefined, undefined);
  });

  /**
   * ADR-0006: a promoted artifact is owned by the extension, so a completed
   * download records a second replica instead of retiring the source. This is
   * the ordering that makes a failed download survivable, and it is emphatically
   * not "stop calling cleanup" — ownership moved out of staging first.
   */
  describe('retained artifacts', () => {
    const historyDouble = () => ({
      createPending: jest.fn().mockResolvedValue(undefined),
      localSaveSettled: jest.fn().mockResolvedValue(undefined),
      setDuration: jest.fn().mockResolvedValue(undefined),
      recordArtifactLocation: jest.fn().mockResolvedValue(undefined),
    });

    it('persists the retained copy before the download is attempted', async () => {
      const history = historyDouble();
      registerSaveHandler(offscreen, L, history);

      offscreen.onSaveRequested({
        historyId: 'recording:1', stream: 'tab', filename: 'demo-recording.webm',
        blobUrl: 'blob:1', opfsFilename: 'staging/demo-recording.webm',
        retainedKey: 'library/recording%3A1/recording%3A1%3Atab.webm',
      });
      await flushMicrotasks();

      expect(history.recordArtifactLocation).toHaveBeenCalledWith(
        'recording:1',
        'recording:1:tab',
        { kind: 'opfs', key: 'library/recording%3A1/recording%3A1%3Atab.webm', retainedAt: expect.any(Number) },
      );
      // Ordering matters: the replica is on record before Chrome is asked to download.
      expect(history.recordArtifactLocation.mock.invocationCallOrder[0])
        .toBeLessThan((downloadFile as jest.Mock).mock.invocationCallOrder[0]);
    });

    it('keeps the retained file when the download completes, freeing only the URL', async () => {
      registerSaveHandler(offscreen, L, historyDouble());

      offscreen.onSaveRequested({
        historyId: 'recording:1', stream: 'tab', filename: 'demo-recording.webm',
        blobUrl: 'blob:1', opfsFilename: 'staging/demo-recording.webm',
        retainedKey: 'library/recording%3A1/recording%3A1%3Atab.webm',
      });
      await flushMicrotasks();

      expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1', undefined);
    });

    it('still retires a non-retained staging file on a confirmed download', async () => {
      registerSaveHandler(offscreen, L, historyDouble());

      // No retainedKey: legacy orphan recovery has no history row to own the bytes.
      offscreen.onSaveRequested({
        historyId: 'recording:1', stream: 'tab', filename: 'demo-recording.webm',
        blobUrl: 'blob:1', opfsFilename: 'staging/demo-recording.webm',
      });
      await flushMicrotasks();

      expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1', 'staging/demo-recording.webm');
    });
  });

  /**
   * ADR-0005: the notes sidecar rides a media stream, so `stream` alone cannot
   * identify it. Dropping `kind` on this path made the sidecar collide with the
   * media row — and `createPending` skips a known id, so the recording itself
   * vanished from history.
   */
  it('gives the notes sidecar its own row instead of colliding with its media stream', async () => {
    const history = {
      createPending: jest.fn().mockResolvedValue(undefined),
      localSaveSettled: jest.fn().mockResolvedValue(undefined),
      setDuration: jest.fn().mockResolvedValue(undefined),
      recordArtifactLocation: jest.fn().mockResolvedValue(undefined),
    };
    registerSaveHandler(offscreen, L, history);

    // sortArtifacts delivers the sidecar first, then the media file.
    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', kind: 'notes', filename: 'demo.vtt', blobUrl: 'blob:1' });
    await flushMicrotasks();
    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', filename: 'demo-recording.webm', blobUrl: 'blob:2' });
    await flushMicrotasks();

    expect(history.createPending).toHaveBeenNthCalledWith(
      1,
      'recording:1',
      [{ id: 'recording:1:notes', stream: 'tab', kind: 'notes', filename: 'demo.vtt' }],
      'local',
    );
    expect(history.createPending).toHaveBeenNthCalledWith(
      2,
      'recording:1',
      [{ id: 'recording:1:tab', stream: 'tab', filename: 'demo-recording.webm' }],
      'local',
    );
  });

  it('settles each artifact against its own row, carrying kind through', async () => {
    const history = {
      createPending: jest.fn().mockResolvedValue(undefined),
      localSaveSettled: jest.fn().mockResolvedValue(undefined),
      setDuration: jest.fn().mockResolvedValue(undefined),
      recordArtifactLocation: jest.fn().mockResolvedValue(undefined),
    };
    registerSaveHandler(offscreen, L, history);

    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', kind: 'notes', filename: 'demo.vtt', blobUrl: 'blob:1' });
    await flushMicrotasks();
    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', filename: 'demo-recording.webm', blobUrl: 'blob:2' });
    await flushMicrotasks();

    expect(history.localSaveSettled).toHaveBeenNthCalledWith(1, 'recording:1', 'tab', 1, 'complete', undefined, 'notes');
    expect(history.localSaveSettled).toHaveBeenNthCalledWith(2, 'recording:1', 'tab', 1, 'complete', undefined, undefined);
  });

  it('stamps the run duration onto the row it just created', async () => {
    const history = {
      createPending: jest.fn().mockResolvedValue(undefined),
      localSaveSettled: jest.fn().mockResolvedValue(undefined),
      setDuration: jest.fn().mockResolvedValue(undefined),
      recordArtifactLocation: jest.fn().mockResolvedValue(undefined),
    };
    const runDurationMs = jest.fn().mockReturnValue(63_000);
    registerSaveHandler(offscreen, L, history, runDurationMs);

    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', filename: 'tab.webm', blobUrl: 'blob:1' });
    await flushMicrotasks();

    expect(runDurationMs).toHaveBeenCalledWith('recording:1');
    expect(history.setDuration).toHaveBeenCalledWith('recording:1', 63_000);
    // Ordering matters: the row has to exist before the duration is written.
    expect(history.createPending.mock.invocationCallOrder[0])
      .toBeLessThan(history.setDuration.mock.invocationCallOrder[0]);
  });

  it('still saves when the run duration is unknown', async () => {
    const history = {
      createPending: jest.fn().mockResolvedValue(undefined),
      localSaveSettled: jest.fn().mockResolvedValue(undefined),
      setDuration: jest.fn().mockResolvedValue(undefined),
      recordArtifactLocation: jest.fn().mockResolvedValue(undefined),
    };
    registerSaveHandler(offscreen, L, history, () => undefined);

    offscreen.onSaveRequested({ historyId: 'recording:1', stream: 'tab', filename: 'tab.webm', blobUrl: 'blob:1' });
    await flushMicrotasks();

    expect(history.setDuration).toHaveBeenCalledWith('recording:1', undefined);
    expect(downloadFile).toHaveBeenCalledTimes(1);
  });

  describe('a delivery deferred while the user picks a folder', () => {
    const save = (over: Record<string, unknown> = {}) => ({
      historyId: 'rec-1', stream: 'tab', filename: 'tab.webm',
      blobUrl: 'blob:1', retainedKey: 'library/rec-1/tab.webm', deferDelivery: true, ...over,
    });

    it('reports what actually happened, so a caller cannot claim a failed save', async () => {
      // The whole point: deliver() handles the failure internally, so the only
      // way a caller learns of it is the returned outcome.
      (downloadFile as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      const { deliverDeferred } = registerSaveHandler(offscreen, L);
      const entry = {
        id: 'rec-1',
        files: [{
          stream: 'tab' as const, filename: 'tab.webm', delivery: { requested: 'local', status: 'pending' },
          locations: [{ kind: 'opfs' as const, key: 'library/rec-1/tab.webm', retainedAt: 1 }],
        }],
      };
      offscreen.openRetained = jest.fn(async () => 'blob:9');

      const outcomes = await deliverDeferred(entry as never, 'Therapy');
      expect(outcomes).toEqual([{ status: 'not-started', error: 'disk full' }]);
    });

    it('reports a completed delivery as complete', async () => {
      const { deliverDeferred } = registerSaveHandler(offscreen, L);
      const entry = {
        id: 'rec-1',
        files: [{
          stream: 'tab' as const, filename: 'tab.webm', delivery: { requested: 'local', status: 'pending' },
          locations: [{ kind: 'opfs' as const, key: 'library/rec-1/tab.webm', retainedAt: 1 }],
        }],
      };
      offscreen.openRetained = jest.fn(async () => 'blob:9');

      const outcomes = await deliverDeferred(entry as never, 'Therapy');
      expect(outcomes.map((o) => o.status)).toEqual(['complete']);
      // And it went into the folder, not the download root.
      expect(downloadFile).toHaveBeenCalledWith({
        url: 'blob:9', filename: 'Therapy/tab.webm', saveAs: false,
      });
    });

    it('holds the download and reports that someone is being asked', async () => {
      (broadcastToPopup as jest.Mock).mockResolvedValue(true);
      const deferred = jest.fn();
      registerSaveHandler(offscreen, L, undefined, undefined, async () => 2, deferred);

      offscreen.onSaveRequested(save());
      await flushMicrotasks();

      expect(downloadFile).not.toHaveBeenCalled();
      expect(broadcastToPopup).toHaveBeenCalledWith({ type: 'RECORDING_AWAITING_DELIVERY', historyId: 'rec-1' });
      // The library owns the bytes, so the object URL is not needed until the
      // answer comes; a fresh one is made then.
      expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1');
      expect(deferred).toHaveBeenCalledTimes(1);
    });

    it('writes immediately when the user has defined no folders', async () => {
      (broadcastToPopup as jest.Mock).mockResolvedValue(true);
      const deferred = jest.fn();
      registerSaveHandler(offscreen, L, undefined, undefined, async () => 0, deferred);

      offscreen.onSaveRequested(save());
      await flushMicrotasks();

      // Nothing to choose between, so nobody is interrupted.
      expect(downloadFile).toHaveBeenCalledWith({ url: 'blob:1', filename: 'tab.webm', saveAs: false });
      expect(deferred).not.toHaveBeenCalled();
    });

    it('writes immediately when every popup is closed', async () => {
      // Asking a question nobody hears would strand the recording.
      (broadcastToPopup as jest.Mock).mockResolvedValue(false);
      const deferred = jest.fn();
      registerSaveHandler(offscreen, L, undefined, undefined, async () => 2, deferred);

      offscreen.onSaveRequested(save());
      await flushMicrotasks();

      expect(downloadFile).toHaveBeenCalledWith({ url: 'blob:1', filename: 'tab.webm', saveAs: false });
      expect(deferred).not.toHaveBeenCalled();
    });
  });
});

describe('isFreshRecordingStart', () => {
  it('is true when entering a busy phase from a non-busy one (a new recording begins)', () => {
    expect(isFreshRecordingStart('idle', 'starting')).toBe(true);
    expect(isFreshRecordingStart('failed', 'starting')).toBe(true);
  });

  it('is false for busy-to-busy transitions within a run', () => {
    expect(isFreshRecordingStart('starting', 'recording')).toBe(false);
    expect(isFreshRecordingStart('recording', 'stopping')).toBe(false);
  });

  it('is false when a run finishes (busy to idle) — diagnostics persist until the next start', () => {
    expect(isFreshRecordingStart('stopping', 'idle')).toBe(false);
    expect(isFreshRecordingStart('recording', 'idle')).toBe(false);
  });

  it('is false for idle-to-idle', () => {
    expect(isFreshRecordingStart('idle', 'idle')).toBe(false);
  });
});

describe('keep-alive loop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopKeepAlive();
    jest.useRealTimers();
  });

  it('pokes the runtime on an interval and is idempotent', () => {
    startKeepAlive();
    startKeepAlive(); // second call must not add a second interval

    jest.advanceTimersByTime(20_000);
    expect(pokeRuntime).toHaveBeenCalledTimes(1);
  });

  it('stops poking after stopKeepAlive', () => {
    startKeepAlive();
    jest.advanceTimersByTime(20_000);
    stopKeepAlive();
    jest.advanceTimersByTime(60_000);
    expect(pokeRuntime).toHaveBeenCalledTimes(1);
  });

});
