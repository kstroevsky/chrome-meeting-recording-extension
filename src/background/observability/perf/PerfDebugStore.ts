/**
 * @file background/observability/perf/PerfDebugStore.ts
 *
 * Aggregates perf events into a session-scoped diagnostics snapshot that can be
 * rendered by the debug dashboard and persisted across service worker restarts.
 */

import {
  HIGH_FREQUENCY_PERF_EVENTS,
  PERF_EVENT_BUFFER_LIMIT,
  type PerfDebugSnapshot,
  type PerfEventEntry,
  type PerfPhase,
  type PerfSettings,
} from '../../../shared/perf';
import { createEmptySnapshot, normalizeSummary } from './PerfDebugState';
import { PerfDebugPersistence } from './PerfDebugPersistence';
import { applyCapture } from './reducers/capture';
import { applyCaptionLongTask, applyCaptionMutation, applyObserverCount } from './reducers/captions';
import { applyDriveChunk, applyDriveFile, applyDriveFileComplete, applyDriveFinalize } from './reducers/drive';
import { applyFinalization } from './reducers/finalization';
import { applyLifecycle } from './reducers/lifecycle';
import {
  applyArtifactSealed,
  applyAudioBridge,
  applyRecorderBitrateObserved,
  applyRecorderChunk,
  applyRecorderStarted,
  applySelfVideoStream,
} from './reducers/recorder';
import { applyCpuSample, applyRuntimeSample } from './reducers/runtime';
import { applyStorage } from './reducers/storage';

export class PerfDebugStore {
  private snapshot: PerfDebugSnapshot;
  private readonly persistence: PerfDebugPersistence;

  constructor(
    initialSettings: PerfSettings,
    warn: (...args: any[]) => void = () => {}
  ) {
    this.snapshot = createEmptySnapshot(initialSettings);
    this.persistence = new PerfDebugPersistence(warn);
  }

  hydrate(snapshot: PerfDebugSnapshot | null | undefined): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.snapshot = {
      enabled: snapshot.enabled === true,
      settings: snapshot.settings ?? this.snapshot.settings,
      updatedAt: typeof snapshot.updatedAt === 'number' ? snapshot.updatedAt : null,
      droppedEvents: typeof snapshot.droppedEvents === 'number' ? snapshot.droppedEvents : 0,
      entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
      summary: normalizeSummary(snapshot.summary),
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

    // Append to the raw log FIRST — several summary reducers recompute their
    // windowed percentiles by scanning `entries`, so the current event must be in
    // the buffer before they run. Retention is priority-tiered: on overflow the
    // oldest high-frequency *sample* is evicted, never a rare signal event, so a
    // multi-hour recording still keeps its failures/warnings/phase transitions.
    this.appendRawEntry(entry);
    this.snapshot.updatedAt = entry.ts;

    // Then update the whole-session aggregates (count/avg/max are incremental and
    // full-run accurate; percentiles reflect the retained window in `entries`).
    this.aggregate(entry);
    this.persist();
  }

  /** Updates the whole-session aggregates for a single event. */
  private aggregate(entry: PerfEventEntry): void {
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
      case 'recorder:bitrate_observed':
        applyRecorderBitrateObserved(this.snapshot, entry);
        break;
      case 'recorder:artifact_sealed':
        applyArtifactSealed(this.snapshot, entry);
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
      case 'captions:mutation_processed':
        applyCaptionMutation(this.snapshot, entry);
        break;
      case 'captions:long_task':
        applyCaptionLongTask(this.snapshot, entry);
        break;
      case 'capture:stream_acquired':
      case 'capture:stream_failed':
        applyCapture(this.snapshot, entry);
        break;
      case 'storage:opfs_opened':
      case 'storage:opfs_open_failed':
      case 'storage:opfs_write_complete':
      case 'storage:opfs_closed':
      case 'storage:opfs_cleanup':
        applyStorage(this.snapshot, entry);
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
      case 'finalizer:local_save_requested':
      case 'finalizer:download_complete':
      case 'finalizer:finalize_complete':
        applyFinalization(this.snapshot, entry);
        break;
      case 'lifecycle:start_requested':
      case 'lifecycle:start_completed':
      case 'lifecycle:stop_requested':
      case 'lifecycle:stop_completed':
      case 'lifecycle:failure':
      case 'lifecycle:warning':
        applyLifecycle(this.snapshot, entry);
        break;
      case 'runtime:sample':
        applyRuntimeSample(this.snapshot, entry);
        break;
      case 'runtime:cpu':
        applyCpuSample(this.snapshot, entry);
        break;
    }
  }

  /**
   * Appends an event to the raw log, bounding it to PERF_EVENT_BUFFER_LIMIT. On
   * overflow it evicts the oldest *high-frequency sample*, never a rare signal
   * event (lifecycle, failures, warnings, opens/closes/finalize), so those survive
   * a multi-hour recording for attribution. `droppedEvents` records evictions.
   */
  private appendRawEntry(entry: PerfEventEntry): void {
    this.snapshot.entries.push(entry);
    if (this.snapshot.entries.length <= PERF_EVENT_BUFFER_LIMIT) return;

    let idx = this.snapshot.entries.findIndex(
      (e) => HIGH_FREQUENCY_PERF_EVENTS.has(`${e.scope}:${e.event}`)
    );
    if (idx === -1) idx = 0; // buffer is all signal (pathological): evict the oldest
    this.snapshot.entries.splice(idx, 1);
    this.snapshot.droppedEvents += 1;
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
    this.persistence.clear();
  }

  private persist(delayMs = 400): void {
    this.persistence.schedule(() => this.getSnapshot(), delayMs);
  }
}
