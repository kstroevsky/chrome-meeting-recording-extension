import { PerfDebugStore } from '../src/background/PerfDebugStore';
import { PERF_DEBUG_SNAPSHOT_STORAGE_KEY, normalizePerfSettings, type PerfEventEntry } from '../src/shared/perf';

function event(
  scope: string,
  name: string,
  fields: Record<string, string | number | boolean | null> = {}
): PerfEventEntry {
  return {
    source: 'offscreen',
    scope,
    event: name,
    ts: Date.now(),
    fields,
  };
}

describe('PerfDebugStore', () => {
  beforeEach(() => {
    (globalThis as any).__DEV_BUILD__ = true;
  });

  afterEach(() => {
    (globalThis as any).__DEV_BUILD__ = false;
    jest.restoreAllMocks();
  });

  it('aggregates recorder, upload, caption, and runtime metrics into one snapshot', () => {
    const store = new PerfDebugStore(normalizePerfSettings({ debugMode: true }));

    store.setPhase('recording');
    store.record(event('recorder', 'recorder_started', {
      stream: 'tab',
      latencyMs: 120,
      timesliceMs: 4000,
    }));
    store.record(event('recorder', 'chunk_persisted', {
      stream: 'tab',
      chunkBytes: 2048,
      durationMs: 12,
    }));
    store.record(event('captions', 'observer_count', {
      activeBlockObservers: 3,
    }));
    store.record(event('drive', 'chunk_uploaded', {
      chunkBytes: 2 * 1024 * 1024,
      durationMs: 1000,
      attempts: 2,
      retried: true,
    }));
    store.record(event('finalizer', 'drive_file_complete', {
      uploaded: false,
    }));
    store.record(event('runtime', 'sample', {
      phase: 'uploading',
      activeRecorders: 0,
      hardwareConcurrency: 8,
      deviceMemoryGb: 16,
      usedJSHeapSizeMb: 48.2,
      totalJSHeapSizeMb: 96.4,
      jsHeapSizeLimitMb: 256,
      eventLoopLagMs: 3.1,
      longTaskCount: 2,
      lastLongTaskMs: 112.5,
      maxLongTaskMs: 130.2,
    }));

    const snapshot = store.getSnapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.summary.currentPhase).toBe('uploading');
    expect(snapshot.summary.recorder.lastStartLatencyMsByStream.tab).toBe(120);
    expect(snapshot.summary.recorder.lastTimesliceMs).toBe(4000);
    expect(snapshot.summary.recorder.persistedChunkCount).toBe(1);
    expect(snapshot.summary.captions.currentObserverCount).toBe(3);
    expect(snapshot.summary.upload.chunkCount).toBe(1);
    expect(snapshot.summary.upload.retryCount).toBe(1);
    expect(snapshot.summary.upload.fallbackCount).toBe(1);
    expect(snapshot.summary.runtime.hardwareConcurrency).toBe(8);
    expect(snapshot.summary.runtime.deviceMemoryGb).toBe(16);
    expect(snapshot.summary.runtime.lastHeapUsedMb).toBe(48.2);
    expect(snapshot.summary.runtime.lastTotalHeapMb).toBe(96.4);
    expect(snapshot.summary.runtime.lastEventLoopLagMs).toBe(3.1);
    expect(snapshot.summary.runtime.longTaskCount).toBe(2);
  });

  it('clears collected metrics when debug mode is disabled', () => {
    const store = new PerfDebugStore(normalizePerfSettings({ debugMode: true }));
    store.record(event('captions', 'observer_count', { activeBlockObservers: 2 }));

    (globalThis as any).__DEV_BUILD__ = false;
    store.setSettings(normalizePerfSettings({}));
    const snapshot = store.getSnapshot();

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.summary.totalEvents).toBe(0);
  });

  it('keeps the full active-session event history until explicitly cleared', () => {
    const store = new PerfDebugStore(normalizePerfSettings({ debugMode: true }));
    store.record(event('runtime', 'sample', { phase: 'recording' }));
    store.record(event('runtime', 'sample', { phase: 'uploading' }));
    const snapshot = store.getSnapshot();

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0].fields.phase).toBe('recording');
    expect(snapshot.entries[1].fields.phase).toBe('uploading');
  });

  it('clears in-memory and persisted diagnostics snapshots on clear()', async () => {
    const store = new PerfDebugStore(normalizePerfSettings({ debugMode: true }));
    store.record(event('runtime', 'sample', { phase: 'recording' }));

    store.clear();
    await Promise.resolve();

    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.summary.totalEvents).toBe(0);
    expect(chrome.storage.session.remove).toHaveBeenCalledWith(PERF_DEBUG_SNAPSHOT_STORAGE_KEY);
  });
});
