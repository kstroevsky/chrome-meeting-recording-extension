import { DebugDashboard } from '../src/debug/DebugDashboard';
import { PERF_DEBUG_SNAPSHOT_STORAGE_KEY } from '../src/shared/perf';

function makeElements() {
  const eventsScrollEl = document.createElement('div');
  Object.defineProperty(eventsScrollEl, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(eventsScrollEl, 'scrollHeight', { configurable: true, get: () => 400 });
  return {
    buildBadgeEl: document.createElement('div'),
    updatedAtEl: document.createElement('div'),
    summaryEl: document.createElement('pre'),
    recorderEl: document.createElement('pre'),
    uploadEl: document.createElement('pre'),
    captionsEl: document.createElement('pre'),
    runtimeEl: document.createElement('pre'),
    systemEl: document.createElement('pre'),
    eventsScrollEl,
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
    const disconnect = jest.fn();
    (chrome.runtime.connect as jest.Mock).mockReturnValue({
      disconnect,
      onDisconnect: { addListener: jest.fn() },
    });
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
            hardwareConcurrency: 8,
            deviceMemoryGb: 16,
            lastHeapUsedMb: 48.5,
            lastTotalHeapMb: 96.4,
            maxHeapUsedMb: 49.2,
            lastHeapLimitMb: 256,
            lastEventLoopLagMs: 3.1,
            avgEventLoopLagMs: 2.2,
            maxEventLoopLagMs: 6.4,
            longTaskCount: 4,
            lastLongTaskMs: 112.8,
            maxLongTaskMs: 140.2,
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
    expect(elements.summaryEl.textContent).toContain('Retained events: 1');
    expect(elements.updatedAtEl.textContent).toContain('.321');
    expect(elements.eventsBodyEl.textContent).toContain('chunk_uploaded');
    expect(elements.eventsBodyEl.textContent).toContain('.321');
    expect(elements.runtimeEl.textContent).toContain('CPU pressure proxy');
    expect(elements.systemEl.textContent).toContain('Chrome extension APIs');

    elements.downloadBtn.click();

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:debug');
    dashboard.destroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('renders the full event history instead of truncating to the last rows', async () => {
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
        entries: Array.from({ length: 40 }, (_, index) => ({
          source: 'offscreen',
          scope: 'runtime',
          event: `sample_${index}`,
          ts: timestamp + index,
          fields: { index },
        })),
        summary: {
          currentPhase: 'recording',
          totalEvents: 40,
          countsByScope: { runtime: 40 },
          recorder: {
            startCountByStream: {},
            lastStartLatencyMsByStream: {},
            avgStartLatencyMsByStream: {},
            persistedChunkCount: 0,
            persistedChunkBytes: 0,
            avgPersistedChunkDurationMs: null,
            lastPersistedChunkDurationMs: null,
            lastPersistedChunkBytes: null,
            lastTimesliceMs: null,
            lastSelfVideoBitrate: null,
            lastAudioBridgeMode: null,
            lastAudioBridgeSuppressed: null,
            lastAudioBridgeEnabled: null,
          },
          captions: {
            currentObserverCount: 0,
            maxObserverCount: 0,
          },
          upload: {
            chunkCount: 0,
            totalChunkBytes: 0,
            avgChunkDurationMs: null,
            lastChunkDurationMs: null,
            lastChunkBytes: null,
            lastChunkThroughputMbps: null,
            retryCount: 0,
            retriedChunkCount: 0,
            fileCount: 0,
            uploadedCount: 0,
            fallbackCount: 0,
            avgFileDurationMs: null,
            lastFileDurationMs: null,
            lastFallbackRate: null,
            lastConcurrency: null,
          },
          runtime: {
            sampleCount: 40,
            state: 'recording',
            activeRecorders: 1,
            hardwareConcurrency: 8,
            deviceMemoryGb: 16,
            lastHeapUsedMb: 48.5,
            lastTotalHeapMb: 96.4,
            maxHeapUsedMb: 49.2,
            lastHeapLimitMb: 256,
            lastEventLoopLagMs: 3.1,
            avgEventLoopLagMs: 2.2,
            maxEventLoopLagMs: 6.4,
            longTaskCount: 4,
            lastLongTaskMs: 112.8,
            maxLongTaskMs: 140.2,
          },
        },
      },
    });

    dashboard.init();
    await new Promise(process.nextTick);

    expect(elements.eventsBodyEl.querySelectorAll('tr')).toHaveLength(40);
    expect(elements.eventsBodyEl.textContent).toContain('sample_0');
    expect(elements.eventsBodyEl.textContent).toContain('sample_39');

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
