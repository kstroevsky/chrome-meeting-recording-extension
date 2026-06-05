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

  it('aggregates expanded capture, storage, finalization, caption, and lifecycle metrics', () => {
    const store = new PerfDebugStore(normalizePerfSettings({ debugMode: true }));

    store.record(event('lifecycle', 'start_requested', { activeTracks: 0 }));
    store.record(event('capture', 'stream_acquired', {
      stream: 'tab',
      durationMs: 25,
      requestedWidth: 1280,
      requestedHeight: 720,
      requestedFrameRate: 24,
      width: 1280,
      height: 720,
      frameRate: 24,
    }));
    store.record(event('storage', 'opfs_opened', {
      stream: 'tab',
      durationMs: 4,
      pendingWrites: 0,
    }));
    store.record(event('recorder', 'chunk_persisted', {
      stream: 'tab',
      chunkBytes: 2_048,
      durationMs: 10,
      throughputMbps: 0.2,
    }));
    store.record(event('recorder', 'chunk_persisted', {
      stream: 'tab',
      chunkBytes: 4_096,
      durationMs: 30,
      throughputMbps: 0.13,
    }));
    store.record(event('storage', 'opfs_write_complete', {
      stream: 'tab',
      durationMs: 30,
      pendingWrites: 2,
      chunkBytes: 6_144,
      throughputMbps: 0.2,
    }));
    store.record(event('recorder', 'artifact_sealed', {
      stream: 'tab',
      durationMs: 12,
      artifactBytes: 6_144,
    }));
    store.record(event('finalizer', 'finalize_complete', {
      durationMs: 18,
      artifactCount: 1,
      storageMode: 'local',
    }));
    const firstMutation = event('captions', 'mutation_processed', {
      durationMs: 3,
      sourceLatencyMs: 7,
      changed: true,
      coalesced: false,
    });
    firstMutation.ts = 1_000;
    store.record(firstMutation);
    const secondMutation = event('captions', 'mutation_processed', {
      durationMs: 9,
      sourceLatencyMs: 11,
      changed: false,
      coalesced: true,
    });
    secondMutation.ts = 2_000;
    store.record(secondMutation);
    store.record(event('lifecycle', 'stop_completed', {
      durationMs: 35,
      activeTracks: 0,
    }));

    const snapshot = store.getSnapshot();

    expect(snapshot.summary.capture.successCountByStream.tab).toBe(1);
    expect(snapshot.summary.capture.lastDurationMsByStream.tab).toBe(25);
    expect(snapshot.summary.capture.lastDeliveredProfileByStream.tab).toEqual({
      width: 1280,
      height: 720,
      frameRate: 24,
    });
    expect(snapshot.summary.recorder.chunkCountByStream.tab).toBe(2);
    expect(snapshot.summary.recorder.chunkBytesByStream.tab).toBe(6_144);
    expect(snapshot.summary.recorder.chunkWriteDurationMsByStream.tab).toEqual(
      expect.objectContaining({
        count: 2,
        avg: 20,
        p50: 10,
        p95: 30,
        max: 30,
      })
    );
    expect(snapshot.summary.recorder.lastChunkThroughputMbpsByStream.tab).toBe(0.13);
    expect(snapshot.summary.recorder.lastSealDurationMsByStream.tab).toBe(12);
    expect(snapshot.summary.storage.openCount).toBe(1);
    expect(snapshot.summary.storage.peakPendingWrites).toBe(2);
    expect(snapshot.summary.storage.writeCountByStream.tab).toBe(1);
    expect(snapshot.summary.storage.writtenBytesByStream.tab).toBe(6_144);
    expect(snapshot.summary.storage.lastWriteThroughputMbpsByStream.tab).toBe(0.2);
    expect(snapshot.summary.finalization.lastDurationMs).toBe(18);
    expect(snapshot.summary.captions.mutationCount).toBe(2);
    expect(snapshot.summary.captions.changedMutationCount).toBe(1);
    expect(snapshot.summary.captions.coalescedMutationCount).toBe(1);
    expect(snapshot.summary.captions.missedMutationCount).toBe(1);
    expect(snapshot.summary.captions.mutationThroughputPerSecond).toBe(1);
    expect(snapshot.summary.captions.processingDurationMs).toEqual(
      expect.objectContaining({ count: 2, p50: 3, p95: 9, max: 9 })
    );
    expect(snapshot.summary.captions.sourceLatencyMs).toEqual(
      expect.objectContaining({ count: 2, p50: 7, p95: 11, max: 11 })
    );
    expect(snapshot.summary.lifecycle.startRequestedCount).toBe(1);
    expect(snapshot.summary.lifecycle.stopCompletedCount).toBe(1);
    expect(snapshot.summary.lifecycle.lastStopDurationMs).toBe(35);
  });

  it('normalizes persisted snapshots created before expanded metrics existed', () => {
    const store = new PerfDebugStore(normalizePerfSettings({ debugMode: true }));
    store.hydrate({
      enabled: true,
      settings: normalizePerfSettings({ debugMode: true }),
      updatedAt: 10,
      droppedEvents: 0,
      entries: [],
      summary: {
        currentPhase: 'recording',
        totalEvents: 1,
        countsByScope: { recorder: 1 },
        recorder: {
          startCountByStream: { tab: 1 },
          lastStartLatencyMsByStream: { tab: 15 },
        },
        captions: {
          currentObserverCount: 1,
          maxObserverCount: 1,
        },
        upload: {
          chunkCount: 0,
        },
        runtime: {
          state: 'recording',
          sampleCount: 0,
        },
      } as any,
    });

    store.record(event('storage', 'opfs_opened', { durationMs: 2 }));
    const snapshot = store.getSnapshot();

    expect(snapshot.summary.capture.attemptCountByStream).toEqual({});
    expect(snapshot.summary.recorder.lastStartLatencyMsByStream.tab).toBe(15);
    expect(snapshot.summary.recorder.chunkCountByStream).toEqual({});
    expect(snapshot.summary.storage.openCount).toBe(1);
    expect(snapshot.summary.captions.processingDurationMs.count).toBe(0);
    expect(snapshot.summary.captions.mutationThroughputPerSecond).toBeNull();
    expect(snapshot.summary.lifecycle.startRequestedCount).toBe(0);
    expect(snapshot.summary.runtime.state).toBe('recording');
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
