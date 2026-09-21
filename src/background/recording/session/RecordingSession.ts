/** Canonical background-owned recording session state machine (ADR-0003). */

import {
  createIdleSession,
  normalizeSessionSnapshot,
  type RecordingInputDevice,
  type RecordingInterruption,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadJob,
  type UploadSummary,
} from '../../../shared/recording';
import type { OffscreenPhaseUpdate } from '../../../shared/protocol';
import { createRecordingHistoryId } from '../../../shared/recordingHistory';
import {
  elapsedRecordedMs,
  recordedMsAt as projectRecordedMsAt,
  recordedRangeAt as projectRecordedRangeAt,
  timerForPause,
} from './RecordingClock';
import {
  failedSession,
  idleSession,
  observedSession,
  removeUploadJob as removeUploadJobFromSnapshot,
  startSession,
  stoppingSession,
  upsertUploadJob as upsertUploadJobInSnapshot,
  type RecordingTarget,
} from './RecordingSessionTransitions';

export type { RecordingTarget } from './RecordingSessionTransitions';

export type SessionChangeListener = (snapshot: RecordingSessionSnapshot) => void;
export type SessionPersistor = (snapshot: RecordingSessionSnapshot) => Promise<void> | void;
export type RunEnding = 'kept' | 'discarded';

/**
 * Imperative shell around pure session transitions and the recording clock.
 * This remains the single authority that mutates, persists, and publishes the
 * canonical snapshot.
 */
export class RecordingSession {
  private lastRun?: { historyId: string; durationMs: number };
  private pendingInterruption?: RecordingInterruption;
  private snapshot: RecordingSessionSnapshot = createIdleSession();
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly persist: SessionPersistor,
    private readonly onChanged?: SessionChangeListener,
    private readonly onRunFinished?: (
      historyId: string,
      durationMs: number,
      ending: RunEnding,
    ) => void,
  ) {}

  hydrate(value: unknown): RecordingSessionSnapshot {
    this.snapshot = normalizeSessionSnapshot(value);
    return this.commit();
  }

  dismissInterruption(): RecordingSessionSnapshot {
    this.pendingInterruption = undefined;
    this.snapshot = { ...this.snapshot, interruption: undefined, updatedAt: Date.now() };
    return this.commit();
  }

  getSnapshot(): RecordingSessionSnapshot {
    return structuredClone(this.snapshot);
  }

  start(runConfig: RecordingRunConfig, target?: RecordingTarget): RecordingSessionSnapshot {
    this.pendingInterruption = undefined;
    this.snapshot = startSession(
      this.snapshot,
      runConfig,
      target,
      createRecordingHistoryId(),
      Date.now(),
    );
    return this.commit();
  }

  markStopping(
    interruption?: RecordingInterruption['reason'],
    ending: RunEnding = 'kept',
  ): RecordingSessionSnapshot {
    const now = Date.now();
    const { historyId } = this.snapshot;
    const atMs = elapsedRecordedMs(this.snapshot, now);
    this.rememberFinishedRun(now, ending);
    if (interruption && historyId) {
      this.pendingInterruption = { reason: interruption, atMs, historyId };
    }
    this.snapshot = stoppingSession(this.snapshot, this.pendingInterruption, now);
    return this.commit();
  }

  markIdle(uploadSummary?: UploadSummary, warnings?: string[]): RecordingSessionSnapshot {
    this.rememberFinishedRun(Date.now());
    this.snapshot = idleSession(
      this.snapshot,
      this.pendingInterruption,
      uploadSummary,
      warnings,
      Date.now(),
      Date.now(),
    );
    return this.commit();
  }

  fail(error: string): RecordingSessionSnapshot {
    const now = Date.now();
    this.rememberFinishedRun(now);
    this.snapshot = failedSession(this.snapshot, error, now);
    return this.commit();
  }

  setMicMuted(muted: boolean): RecordingSessionSnapshot {
    this.snapshot = { ...this.snapshot, micMuted: muted || undefined, updatedAt: Date.now() };
    return this.commit();
  }

  setCameraMuted(muted: boolean): RecordingSessionSnapshot {
    this.snapshot = { ...this.snapshot, cameraMuted: muted || undefined, updatedAt: Date.now() };
    return this.commit();
  }

  setCapturedDevice(device: RecordingInputDevice, label: string): RecordingSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      capturedDevices: { ...this.snapshot.capturedDevices, [device]: label },
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  setPaused(paused: boolean): RecordingSessionSnapshot {
    const now = Date.now();
    this.snapshot = {
      ...this.snapshot,
      paused: paused || undefined,
      ...timerForPause(this.snapshot, paused, now),
      updatedAt: now,
    };
    return this.commit();
  }

  currentRecordedMs(now: number = Date.now()): number {
    return elapsedRecordedMs(this.snapshot, now);
  }

  recordedMsAt(wallClockMs: number, now: number = Date.now()): number | undefined {
    return projectRecordedMsAt(this.snapshot, wallClockMs, now);
  }

  recordedRangeAt(
    startWallMs: number,
    endWallMs: number,
    now: number = Date.now(),
  ): { tStartMs: number; tEndMs: number } | undefined {
    return projectRecordedRangeAt(this.snapshot, startWallMs, endWallMs, now);
  }

  runDurationMs(historyId: string | undefined): number | undefined {
    if (!historyId) return undefined;
    if (this.snapshot.historyId === historyId) return this.currentRecordedMs();
    return this.lastRun?.historyId === historyId ? this.lastRun.durationMs : undefined;
  }

  applyOffscreenPhase(update: OffscreenPhaseUpdate): RecordingSessionSnapshot {
    const { phase, error, uploadSummary, warnings } = update;
    if (phase === 'idle') return this.markIdle(uploadSummary, warnings);
    if (phase === 'failed') {
      this.snapshot.warnings = warnings;
      return this.fail(error ?? 'Recording runtime failed');
    }
    this.snapshot = observedSession(this.snapshot, update, Date.now());
    return this.commit();
  }

  upsertUploadJob(job: UploadJob): RecordingSessionSnapshot {
    this.snapshot = upsertUploadJobInSnapshot(this.snapshot, job, Date.now());
    return this.commit();
  }

  removeUploadJob(id: string): RecordingSessionSnapshot {
    this.snapshot = removeUploadJobFromSnapshot(this.snapshot, id, Date.now());
    return this.commit();
  }

  async flush(): Promise<void> {
    await this.persistenceTail;
  }

  private rememberFinishedRun(now: number, ending: RunEnding = 'kept'): void {
    const { historyId } = this.snapshot;
    if (!historyId) return;
    const alreadyAnnounced = this.lastRun?.historyId === historyId;
    const durationMs = alreadyAnnounced
      ? this.lastRun!.durationMs
      : elapsedRecordedMs(this.snapshot, now);
    this.lastRun = { historyId, durationMs };
    if (!alreadyAnnounced) this.onRunFinished?.(historyId, durationMs, ending);
  }

  private commit(): RecordingSessionSnapshot {
    const snapshot = this.getSnapshot();
    const write = this.persistenceTail.catch(() => {}).then(async () => {
      await this.persist(snapshot);
    });
    this.persistenceTail = write;
    void write.catch(() => {});
    this.onChanged?.(snapshot);
    return snapshot;
  }
}
