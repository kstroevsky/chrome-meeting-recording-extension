import { DebugDashboard } from '../src/debug/DebugDashboard';
import { PERF_DEBUG_SNAPSHOT_STORAGE_KEY } from '../src/shared/perf';

function makeElements() {
  return {
    buildBadgeEl: document.createElement('div'),
    updatedAtEl: document.createElement('div'),
    summaryEl: document.createElement('pre'),
    recorderEl: document.createElement('pre'),
    uploadEl: document.createElement('pre'),
    captionsEl: document.createElement('pre'),
    runtimeEl: document.createElement('pre'),
    eventsBodyEl: document.createElement('tbody'),
    downloadBtn: document.createElement('button'),
  };
}

describe('DebugDashboard', () => {
  afterEach(() => {
    (globalThis as any).__DEV_BUILD__ = false;
    jest.restoreAllMocks();
  });

  it('renders realtime diagnostics with human-readable timestamps and exports JSON', async () => {
    (globalThis as any).__DEV_BUILD__ = true;
    const elements = makeElements();
    const dashboard = new DebugDashboard(elements);
    const timestamp = new Date('2026-03-08T12:34:56.321Z').getTime();

    (chrome.storage.session.get as jest.Mock).mockResolvedValue({
      [PERF_DEBUG_SNAPSHOT_STORAGE_KEY]: {
        enabled: true,
        settings: {
          debugMode: true,
          audioPlaybackBridgeMode: 'always',
          adaptiveSelfVideoProfile: false,
          extendedTimeslice: false,
          dynamicDriveChunkSizing: false,
          parallelUploadConcurrency: 1,
        },
        updatedAt: timestamp,
        droppedEvents: 0,
        entries: [
          {
            source: 'offscreen',
            scope: 'drive',
            event: 'chunk_uploaded',
            ts: timestamp,
            fields: { chunkBytes: 1024, durationMs: 88.5 },
          },
        ],
        summary: {
          currentPhase: 'uploading',
          totalEvents: 3,
          countsByScope: { drive: 1 },
          recorder: {
            startCountByStream: { tab: 1 },
            lastStartLatencyMsByStream: { tab: 150 },
            avgStartLatencyMsByStream: { tab: 150 },
            persistedChunkCount: 2,
            persistedChunkBytes: 2048,
            avgPersistedChunkDurationMs: 12.5,
            lastPersistedChunkDurationMs: 14,
            lastPersistedChunkBytes: 1024,
            lastTimesliceMs: 4000,
            lastSelfVideoBitrate: 1200000,
            lastAudioBridgeMode: 'always',
            lastAudioBridgeSuppressed: true,
            lastAudioBridgeEnabled: true,
          },
          captions: {
            currentObserverCount: 2,
            maxObserverCount: 3,
          },
          upload: {
            chunkCount: 1,
            totalChunkBytes: 1024,
            avgChunkDurationMs: 88.5,
            lastChunkDurationMs: 88.5,
            lastChunkBytes: 1024,
            lastChunkThroughputMbps: 1.2,
            retryCount: 1,
            retriedChunkCount: 1,
            fileCount: 1,
            uploadedCount: 1,
            fallbackCount: 0,
            avgFileDurationMs: 1234,
            lastFileDurationMs: 1234,
            lastFallbackRate: 0,
            lastConcurrency: 1,
          },
          runtime: {
            sampleCount: 2,
            state: 'uploading',
            activeRecorders: 0,
            lastHeapUsedMb: 48.5,
            maxHeapUsedMb: 49.2,
            lastHeapLimitMb: 256,
          },
        },
      },
    });

    (URL as any).createObjectURL = jest.fn().mockReturnValue('blob:debug');
    (URL as any).revokeObjectURL = jest.fn();
    const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    dashboard.init();
    await new Promise(process.nextTick);

    expect(elements.buildBadgeEl.textContent).toBe('Dev build');
    expect(elements.summaryEl.textContent).toContain('Phase: uploading');
    expect(elements.updatedAtEl.textContent).toContain('.321');
    expect(elements.eventsBodyEl.textContent).toContain('chunk_uploaded');
    expect(elements.eventsBodyEl.textContent).toContain('.321');

    elements.downloadBtn.click();

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:debug');
    dashboard.destroy();
  });

  it('shows an unavailable message outside dev builds', () => {
    (globalThis as any).__DEV_BUILD__ = false;
    const elements = makeElements();
    const dashboard = new DebugDashboard(elements);

    dashboard.init();

    expect(elements.buildBadgeEl.textContent).toBe('Production build');
    expect(elements.summaryEl.textContent).toContain('npm run dev');
    expect(elements.downloadBtn.disabled).toBe(true);
  });
});
