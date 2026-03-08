import {
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  PERF_EVENT_BUFFER_LIMIT,
  type PerfDebugSnapshot,
  type PerfDebugSummary,
  type PerfEventEntry,
  type PerfFields,
  type PerfPhase,
  type PerfSettings,
} from '../shared/perf';

function toNumber(value: PerfFields[string]): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toBoolean(value: PerfFields[string]): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function createEmptySummary(): PerfDebugSummary {
  return {
    currentPhase: 'idle',
    totalEvents: 0,
    countsByScope: {},
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
      sampleCount: 0,
      state: 'idle',
      activeRecorders: 0,
      lastHeapUsedMb: null,
      maxHeapUsedMb: null,
      lastHeapLimitMb: null,
    },
  };
}

function createEmptySnapshot(settings: PerfSettings): PerfDebugSnapshot {
  return {
    enabled: settings.debugMode,
    settings,
    updatedAt: null,
    droppedEvents: 0,
    entries: [],
    summary: createEmptySummary(),
  };
}

export class PerfDebugStore {
  private snapshot: PerfDebugSnapshot;
  private persistScheduled = false;

  constructor(
    initialSettings: PerfSettings,
    private readonly warn: (...args: any[]) => void = () => {}
  ) {
    this.snapshot = createEmptySnapshot(initialSettings);
  }

  hydrate(snapshot: PerfDebugSnapshot | null | undefined): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.snapshot = {
      enabled: snapshot.enabled === true,
      settings: snapshot.settings ?? this.snapshot.settings,
      updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
      droppedEvents: typeof snapshot.droppedEvents === 'number' ? snapshot.droppedEvents : 0,
      entries: Array.isArray(snapshot.entries) ? snapshot.entries.slice(-PERF_EVENT_BUFFER_LIMIT) : [],
      summary: snapshot.summary ?? createEmptySummary(),
    };
  }

  setSettings(settings: PerfSettings): void {
    const debugModeChanged = settings.debugMode !== this.snapshot.settings.debugMode;
    this.snapshot.settings = settings;
    if (debugModeChanged) {
      this.snapshot = createEmptySnapshot(settings);
    } else {
      this.snapshot.enabled = settings.debugMode;
    }
    this.persist();
  }

  setPhase(phase: PerfPhase): void {
    this.snapshot.summary.currentPhase = phase;
    this.snapshot.summary.runtime.state = phase;
    this.snapshot.updatedAt = Date.now();
    this.persist();
  }

  record(entry: PerfEventEntry): void {
    if (!this.snapshot.enabled) return;

    if (this.snapshot.entries.length >= PERF_EVENT_BUFFER_LIMIT) {
      this.snapshot.entries.shift();
      this.snapshot.droppedEvents += 1;
    }
    this.snapshot.entries.push(entry);
    this.snapshot.updatedAt = entry.ts;

    const summary = this.snapshot.summary;
    summary.totalEvents += 1;
    summary.countsByScope[entry.scope] = (summary.countsByScope[entry.scope] ?? 0) + 1;

    switch (`${entry.scope}:${entry.event}`) {
      case 'recorder:recorder_started':
        this.applyRecorderStarted(entry);
        break;
      case 'recorder:chunk_persisted':
        this.applyRecorderChunk(entry);
        break;
      case 'recorder:tab_audio_bridge_check':
        this.applyAudioBridge(entry);
        break;
      case 'recorder:self_video_stream_acquired':
        this.applySelfVideoStream(entry);
        break;
      case 'captions:observer_count':
        this.applyObserverCount(entry);
        break;
      case 'drive:chunk_uploaded':
        this.applyDriveChunk(entry);
        break;
      case 'drive:file_uploaded':
        this.applyDriveFile(entry);
        break;
      case 'finalizer:drive_file_complete':
        this.applyDriveFileComplete(entry);
        break;
      case 'finalizer:drive_finalize_complete':
        this.applyDriveFinalize(entry);
        break;
      case 'runtime:sample':
        this.applyRuntimeSample(entry);
        break;
    }

    this.persist();
  }

  getSnapshot(): PerfDebugSnapshot {
    return {
      enabled: this.snapshot.enabled,
      settings: { ...this.snapshot.settings },
      updatedAt: this.snapshot.updatedAt,
      droppedEvents: this.snapshot.droppedEvents,
      entries: this.snapshot.entries.map((entry) => ({
        ...entry,
        fields: { ...entry.fields },
      })),
      summary: JSON.parse(JSON.stringify(this.snapshot.summary)) as PerfDebugSummary,
    };
  }

  private applyRecorderStarted(entry: PerfEventEntry): void {
    const stream = entry.fields.stream;
    const latencyMs = toNumber(entry.fields.latencyMs);
    const timesliceMs = toNumber(entry.fields.timesliceMs);
    const videoBitsPerSecond = toNumber(entry.fields.videoBitsPerSecond);
    if (stream !== 'tab' && stream !== 'mic' && stream !== 'selfVideo') return;

    const recorder = this.snapshot.summary.recorder;
    const startCount = (recorder.startCountByStream[stream] ?? 0) + 1;
    recorder.startCountByStream[stream] = startCount;
    if (latencyMs != null) {
      recorder.lastStartLatencyMsByStream[stream] = latencyMs;
      const prevAvg = recorder.avgStartLatencyMsByStream[stream] ?? latencyMs;
      recorder.avgStartLatencyMsByStream[stream] = round(
        ((prevAvg * (startCount - 1)) + latencyMs) / startCount
      );
    }
    if (timesliceMs != null) recorder.lastTimesliceMs = timesliceMs;
    if (videoBitsPerSecond != null) recorder.lastSelfVideoBitrate = videoBitsPerSecond;
  }

  private applyRecorderChunk(entry: PerfEventEntry): void {
    const durationMs = toNumber(entry.fields.durationMs);
    const chunkBytes = toNumber(entry.fields.chunkBytes);
    const recorder = this.snapshot.summary.recorder;
    recorder.persistedChunkCount += 1;
    if (chunkBytes != null) {
      recorder.persistedChunkBytes += chunkBytes;
      recorder.lastPersistedChunkBytes = chunkBytes;
    }
    if (durationMs != null) {
      recorder.lastPersistedChunkDurationMs = durationMs;
      const count = recorder.persistedChunkCount;
      const prevAvg = recorder.avgPersistedChunkDurationMs ?? durationMs;
      recorder.avgPersistedChunkDurationMs = round(((prevAvg * (count - 1)) + durationMs) / count);
    }
  }

  private applyAudioBridge(entry: PerfEventEntry): void {
    const recorder = this.snapshot.summary.recorder;
    recorder.lastAudioBridgeMode = entry.fields.mode === 'auto' ? 'auto' : 'always';
    recorder.lastAudioBridgeSuppressed = toBoolean(entry.fields.suppressLocalAudioPlayback);
    recorder.lastAudioBridgeEnabled = toBoolean(entry.fields.willBridge);
  }

  private applySelfVideoStream(entry: PerfEventEntry): void {
    const width = toNumber(entry.fields.width);
    const height = toNumber(entry.fields.height);
    const frameRate = toNumber(entry.fields.frameRate);
    if (width == null || height == null || frameRate == null) return;
    const estimatedPixelsPerSecond = width * height * frameRate;
    this.snapshot.summary.runtime.activeRecorders = Math.max(
      this.snapshot.summary.runtime.activeRecorders,
      estimatedPixelsPerSecond > 0 ? this.snapshot.summary.runtime.activeRecorders : 0
    );
  }

  private applyObserverCount(entry: PerfEventEntry): void {
    const count = toNumber(entry.fields.activeBlockObservers);
    if (count == null) return;
    this.snapshot.summary.captions.currentObserverCount = count;
    this.snapshot.summary.captions.maxObserverCount = Math.max(
      this.snapshot.summary.captions.maxObserverCount,
      count
    );
  }

  private applyDriveChunk(entry: PerfEventEntry): void {
    const upload = this.snapshot.summary.upload;
    const chunkBytes = toNumber(entry.fields.chunkBytes);
    const durationMs = toNumber(entry.fields.durationMs);
    const retried = toBoolean(entry.fields.retried);
    const attempts = toNumber(entry.fields.attempts);

    upload.chunkCount += 1;
    if (chunkBytes != null) {
      upload.totalChunkBytes += chunkBytes;
      upload.lastChunkBytes = chunkBytes;
    }
    if (durationMs != null) {
      upload.lastChunkDurationMs = durationMs;
      const prevAvg = upload.avgChunkDurationMs ?? durationMs;
      upload.avgChunkDurationMs = round(((prevAvg * (upload.chunkCount - 1)) + durationMs) / upload.chunkCount);
      if (chunkBytes != null && durationMs > 0) {
        upload.lastChunkThroughputMbps = round((chunkBytes / 1024 / 1024) / (durationMs / 1000));
      }
    }
    if (retried) upload.retriedChunkCount += 1;
    if (attempts != null && attempts > 1) upload.retryCount += attempts - 1;
  }

  private applyDriveFile(entry: PerfEventEntry): void {
    const upload = this.snapshot.summary.upload;
    const totalBytes = toNumber(entry.fields.totalBytes);
    const durationMs = toNumber(entry.fields.durationMs);
    upload.fileCount += 1;
    if (durationMs != null) {
      upload.lastFileDurationMs = durationMs;
      const prevAvg = upload.avgFileDurationMs ?? durationMs;
      upload.avgFileDurationMs = round(((prevAvg * (upload.fileCount - 1)) + durationMs) / upload.fileCount);
    }
    if (totalBytes != null && totalBytes === 0) {
      upload.lastChunkThroughputMbps = upload.lastChunkThroughputMbps;
    }
  }

  private applyDriveFileComplete(entry: PerfEventEntry): void {
    const uploaded = toBoolean(entry.fields.uploaded);
    if (uploaded == null) return;
    if (uploaded) {
      this.snapshot.summary.upload.uploadedCount += 1;
    } else {
      this.snapshot.summary.upload.fallbackCount += 1;
    }
  }

  private applyDriveFinalize(entry: PerfEventEntry): void {
    const fallbackRate = toNumber(entry.fields.fallbackRate);
    const concurrency = toNumber(entry.fields.concurrency);
    if (fallbackRate != null) this.snapshot.summary.upload.lastFallbackRate = fallbackRate;
    if (concurrency != null) this.snapshot.summary.upload.lastConcurrency = concurrency;
  }

  private applyRuntimeSample(entry: PerfEventEntry): void {
    const runtime = this.snapshot.summary.runtime;
    runtime.sampleCount += 1;

    const phase = entry.fields.phase;
    if (phase === 'idle' || phase === 'recording' || phase === 'uploading') {
      runtime.state = phase;
      this.snapshot.summary.currentPhase = phase;
    }

    const activeRecorders = toNumber(entry.fields.activeRecorders);
    if (activeRecorders != null) runtime.activeRecorders = activeRecorders;

    const heapUsedMb = toNumber(entry.fields.usedJSHeapSizeMb);
    if (heapUsedMb != null) {
      runtime.lastHeapUsedMb = heapUsedMb;
      runtime.maxHeapUsedMb = runtime.maxHeapUsedMb == null
        ? heapUsedMb
        : Math.max(runtime.maxHeapUsedMb, heapUsedMb);
    }

    const heapLimitMb = toNumber(entry.fields.jsHeapSizeLimitMb);
    if (heapLimitMb != null) runtime.lastHeapLimitMb = heapLimitMb;
  }

  private persist(): void {
    if (this.persistScheduled) return;
    if (!chrome.storage?.session?.set) return;

    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      chrome.storage.session
        .set({ [PERF_DEBUG_SNAPSHOT_STORAGE_KEY]: this.getSnapshot() })
        .catch?.((error: any) => this.warn('Failed to persist perf debug snapshot', error));
    });
  }
}
