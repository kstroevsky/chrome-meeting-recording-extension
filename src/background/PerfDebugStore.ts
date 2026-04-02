/**
 * @file background/PerfDebugStore.ts
 *
 * Aggregates perf events into a session-scoped diagnostics snapshot that can be
 * rendered by the debug dashboard and persisted across service worker restarts.
 */

import {
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
  type PerfEventEntry,
  type PerfPhase,
  type PerfSettings,
} from '../shared/perf';
import {
  hasSessionStorageArea,
  removeSessionStorageValues,
  setSessionStorageValues,
} from '../platform/chrome/storage';
import { createEmptySnapshot, createEmptySummary } from './perf/PerfDebugState';
import {
  applyAudioBridge,
  applyDriveChunk,
  applyDriveFile,
  applyDriveFileComplete,
  applyDriveFinalize,
  applyObserverCount,
  applyRecorderChunk,
  applyRecorderStarted,
  applyRuntimeSample,
  applySelfVideoStream,
} from './perf/PerfDebugReducers';

export class PerfDebugStore {
  private snapshot: PerfDebugSnapshot;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

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
      entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
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
    this.persist(0);
  }

  setPhase(phase: PerfPhase): void {
    this.snapshot.summary.currentPhase = phase;
    this.snapshot.summary.runtime.state = phase;
    this.snapshot.updatedAt = Date.now();
    this.persist(0);
  }

  record(entry: PerfEventEntry): void {
    if (!this.snapshot.enabled) return;
    this.snapshot.entries.push(entry);
    this.snapshot.updatedAt = entry.ts;

    const summary = this.snapshot.summary;
    summary.totalEvents += 1;
    summary.countsByScope[entry.scope] = (summary.countsByScope[entry.scope] ?? 0) + 1;

    switch (`${entry.scope}:${entry.event}`) {
      case 'recorder:recorder_started':
        applyRecorderStarted(this.snapshot, entry);
        break;
      case 'recorder:chunk_persisted':
        applyRecorderChunk(this.snapshot, entry);
        break;
      case 'recorder:tab_audio_bridge_check':
        applyAudioBridge(this.snapshot, entry);
        break;
      case 'recorder:self_video_stream_acquired':
        applySelfVideoStream(this.snapshot, entry);
        break;
      case 'captions:observer_count':
        applyObserverCount(this.snapshot, entry);
        break;
      case 'drive:chunk_uploaded':
        applyDriveChunk(this.snapshot, entry);
        break;
      case 'drive:file_uploaded':
        applyDriveFile(this.snapshot, entry);
        break;
      case 'finalizer:drive_file_complete':
        applyDriveFileComplete(this.snapshot, entry);
        break;
      case 'finalizer:drive_finalize_complete':
        applyDriveFinalize(this.snapshot, entry);
        break;
      case 'runtime:sample':
        applyRuntimeSample(this.snapshot, entry);
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
      summary: structuredClone(this.snapshot.summary),
    };
  }

  clear(): void {
    this.snapshot = createEmptySnapshot(this.snapshot.settings);
    this.removePersistedSnapshot();
  }

  private persist(delayMs = 400): void {
    if (!hasSessionStorageArea()) return;
    if (delayMs === 0) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.persistNow();
      return;
    }

    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, delayMs);
  }

  private persistNow(): void {
    void setSessionStorageValues({ [PERF_DEBUG_SNAPSHOT_STORAGE_KEY]: this.getSnapshot() })
      .catch((error: any) => this.warn('Failed to persist perf debug snapshot', error));
  }

  private removePersistedSnapshot(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!hasSessionStorageArea()) return;
    void removeSessionStorageValues(PERF_DEBUG_SNAPSHOT_STORAGE_KEY)
      .catch((error: any) => this.warn('Failed to clear perf debug snapshot', error));
  }
}
