/**
 * @file background/RecordingSession.ts
 *
 * Canonical session state machine for the recording control plane. Background
 * owns this snapshot and persists it across service worker restarts.
 */

import {
  createIdleSession,
  normalizeSessionSnapshot,
  projectPhase,
  type DesiredState,
  type ObservedState,
  type RecordingRunConfig,
  type RecordingInputDevice,
  type RecordingSessionSnapshot,
  type UploadJob,
  type UploadSummary,
} from '../shared/recording';
import type { OffscreenPhaseUpdate } from '../shared/protocol';
import { createRecordingHistoryId } from '../shared/recordingHistory';

export type RecordingTarget = {
  targetTabId: number;
  meetingSlug?: string;
};

export type SessionChangeListener = (snapshot: RecordingSessionSnapshot) => void;
export type SessionPersistor = (snapshot: RecordingSessionSnapshot) => Promise<void> | void;

/**
 * Canonical state machine for a recording session (ADR-0003, Decision 4).
 *
 * The displayed `phase` is **not** stored directly — it is derived from two
 * separately-owned inputs plus a terminal flag:
 *
 *   desired   command-plane intent  (`idle` | `recording`)   — written by start/stop
 *   observed  status-plane report   (offscreen's last state) — written by applyOffscreenPhase
 *   failed    terminal failure flag                          — written by fail / observed failed
 *
 *   phase = projectPhase(desired, observed, failed)
 *
 * Because the command path writes only `desired` and the offscreen-status path
 * writes only `observed`, a late same-run status can no longer overwrite intent:
 * it can at most move the *derived* phase (e.g. after a stop is requested, a late
 * `recording` re-broadcast derives to `stopping`, not back to `recording`). Stale
 * *cross-run* status is dropped by the epoch fence (ADR-0003) before it ever
 * reaches this session. See ADR-0003 and `projectPhase` in shared/recordingProjection.
 *
 *   start()              → desired=recording, observed=starting  ⇒ starting
 *   applyOffscreenPhase() → observed=<reported>                  ⇒ recording / stopping / uploading / …
 *   markStopping()       → desired=idle                          ⇒ stopping (while still capturing)
 *   markIdle()           → desired=idle, observed=idle           ⇒ idle (carries the UploadSummary)
 *   fail()               → failed=true                           ⇒ failed (preserves run context)
 */
export class RecordingSession {
  /**
   * Recorded duration of the run that just ended, keyed by its history id.
   *
   * History rows are created asynchronously by the finalize path, sometimes
   * after the session has already returned to idle and dropped both
   * `historyId` and `recordedMs`. Holding the finished run's duration here lets
   * `runDurationMs` answer correctly whichever order those land in.
   *
   * Deliberately *not* on the snapshot: it would have to be threaded through
   * every snapshot rebuild, and it does not need to survive a service-worker
   * restart — keep-alive is active for the whole stop-to-row window (the phase
   * is `stopping` and uploads are in flight), and the worst case is a missing
   * duration, exactly what the field is fixing.
   */
  private lastRun?: { historyId: string; durationMs: number };

  private snapshot: RecordingSessionSnapshot = createIdleSession();
  private persistenceTail: Promise<void> = Promise.resolve();

  /** Builds the canonical session state machine around persistence and change notifications. */
  constructor(
    private readonly persist: SessionPersistor,
    private readonly onChanged?: SessionChangeListener
  ) {}

  /** Hydrates the in-memory session from previously persisted snapshot data. */
  hydrate(value: unknown): RecordingSessionSnapshot {
    this.snapshot = normalizeSessionSnapshot(value);
    return this.commit();
  }

  /** Returns a defensive clone of the current session snapshot. */
  getSnapshot(): RecordingSessionSnapshot {
    return structuredClone(this.snapshot);
  }

  /** Starts a new session with the chosen run configuration and target tab (desired=recording). */
  start(runConfig: RecordingRunConfig, target?: RecordingTarget): RecordingSessionSnapshot {
    const desired: DesiredState = 'recording';
    const observed: ObservedState = 'starting';
    const carriedUploads = this.snapshot.uploadJobs?.filter((j) => j.status === 'uploading');
    this.snapshot = {
      phase: projectPhase(desired, observed, false),
      desired,
      observed,
      failed: false,
      runConfig,
      targetTabId: target?.targetTabId,
      meetingSlug: target?.meetingSlug,
      historyId: createRecordingHistoryId(),
      warnings: undefined,
      // Fencing token (ADR-0003): a fresh, strictly-increasing epoch per run.
      epoch: (this.snapshot.epoch ?? 0) + 1,
      // Background uploads outlive the run that spawned them (ADR-0004): carry any
      // still-uploading jobs into the new recording so starting one never drops them,
      // while pruning finished tabs so the list can't grow without bound.
      uploadJobs: carriedUploads?.length ? carriedUploads : undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Signals intent to stop (desired=idle); the phase derives to `stopping` while capture drains. */
  markStopping(): RecordingSessionSnapshot {
    const now = Date.now();
    const desired: DesiredState = 'idle';
    const observed = this.snapshot.observed ?? 'starting';
    const failed = this.snapshot.failed ?? false;
    const phase = projectPhase(desired, observed, failed);
    this.snapshot = {
      phase,
      desired,
      observed,
      failed,
      runConfig: this.snapshot.runConfig,
      targetTabId: this.snapshot.targetTabId,
      meetingSlug: this.snapshot.meetingSlug,
      historyId: this.snapshot.historyId,
      warnings: this.snapshot.warnings,
      micMuted: this.snapshot.micMuted,
      cameraMuted: this.snapshot.cameraMuted,
      paused: this.snapshot.paused,
      tabResolution: this.snapshot.tabResolution,
      capturedDevices: this.snapshot.capturedDevices,
      ...this.nextTimer(phase, now),
      epoch: this.snapshot.epoch,
      uploadJobs: this.snapshot.uploadJobs,
      updatedAt: now,
    };
    return this.commit();
  }

  /** Clears run state and moves the session back to idle (desired=idle, observed=idle). */
  markIdle(uploadSummary?: UploadSummary, warnings?: string[]): RecordingSessionSnapshot {
    this.rememberFinishedRun(Date.now());
    this.snapshot = {
      phase: projectPhase('idle', 'idle', false),
      desired: 'idle',
      observed: 'idle',
      failed: false,
      runConfig: null,
      uploadSummary,
      warnings,
      // Preserved across idle so the next run's epoch stays strictly increasing.
      epoch: this.snapshot.epoch,
      // Background upload jobs are phase-independent (ADR-0004): an idle session
      // can still have uploads draining from the recording that just ended.
      uploadJobs: this.snapshot.uploadJobs,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Records a terminal failure (failed=true) while preserving the last active run configuration. */
  fail(error: string): RecordingSessionSnapshot {
    const now = Date.now();
    this.rememberFinishedRun(now);
    const desired = this.snapshot.desired ?? 'idle';
    const observed = this.snapshot.observed ?? 'starting';
    this.snapshot = {
      phase: projectPhase(desired, observed, true),
      desired,
      observed,
      failed: true,
      runConfig: this.snapshot.runConfig,
      targetTabId: this.snapshot.targetTabId,
      meetingSlug: this.snapshot.meetingSlug,
      historyId: this.snapshot.historyId,
      epoch: this.snapshot.epoch,
      error,
      warnings: this.snapshot.warnings,
      micMuted: this.snapshot.micMuted,
      cameraMuted: this.snapshot.cameraMuted,
      paused: this.snapshot.paused,
      tabResolution: this.snapshot.tabResolution,
      capturedDevices: this.snapshot.capturedDevices,
      recordedMs: this.elapsedRecordedMs(now),
      runningSince: undefined,
      uploadJobs: this.snapshot.uploadJobs,
      updatedAt: now,
    };
    return this.commit();
  }

  /**
   * Mirrors the live mic-mute flag actuated in the offscreen recorder onto the
   * session so a reopened popup renders the right toggle. Stored as `true` or
   * omitted (never `false`) to match the snapshot's optional-field convention.
   * Phase/micMode guarding is the caller's job (see RecordingController).
   */
  setMicMuted(muted: boolean): RecordingSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      micMuted: muted || undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Mirrors the live camera-hidden flag actuated in the offscreen recorder. See {@link setMicMuted}. */
  setCameraMuted(muted: boolean): RecordingSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      cameraMuted: muted || undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Replaces one captured-device label after a successful live source switch. */
  setCapturedDevice(device: RecordingInputDevice, label: string): RecordingSessionSnapshot {
    this.snapshot = {
      ...this.snapshot,
      capturedDevices: {
        ...this.snapshot.capturedDevices,
        [device]: label,
      },
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /**
   * Mirrors the live whole-recording pause flag, and freezes/resumes the recording
   * timer with it: pausing banks the running span into `recordedMs` and stops the
   * clock; resuming restarts it. See {@link setMicMuted}. The phase is unchanged
   * (still derived from the planes), so the timer it manages here is not disturbed.
   */
  setPaused(paused: boolean): RecordingSessionSnapshot {
    const now = Date.now();
    this.snapshot = {
      ...this.snapshot,
      paused: paused || undefined,
      recordedMs: paused ? this.elapsedRecordedMs(now) : this.snapshot.recordedMs,
      runningSince: paused ? undefined : (this.snapshot.runningSince ?? now),
      updatedAt: now,
    };
    return this.commit();
  }

  /**
   * Live media-relative position in ms — the offset a mark made *now* maps to
   * in the produced file. Identical to playback position because a paused span
   * is never written into the media (`RecorderEngine.setPaused` pauses every
   * `MediaRecorder`), so no pause-gap correction is needed. See ADR-0005.
   */
  currentRecordedMs(now: number = Date.now()): number {
    return this.elapsedRecordedMs(now);
  }

  /**
   * Recorded duration of a run, whether it is still capturing or already
   * finished — the value a history row should store as its `durationMs`.
   * Returns `undefined` for a run this session knows nothing about.
   */
  runDurationMs(historyId: string | undefined): number | undefined {
    if (!historyId) return undefined;
    if (this.snapshot.historyId === historyId) return this.currentRecordedMs();
    return this.lastRun?.historyId === historyId ? this.lastRun.durationMs : undefined;
  }

  /**
   * Banks the ending run's duration so it outlives the snapshot's timer fields,
   * and announces the end once so open notations can be sealed at that position.
   * Guarded on `historyId`, which is dropped at idle — so a repeated idle report
   * cannot re-announce a run that already finished.
   */
  private rememberFinishedRun(now: number): void {
    const { historyId } = this.snapshot;
    if (!historyId) return;
    const durationMs = this.elapsedRecordedMs(now);
    this.lastRun = { historyId, durationMs };
  }

  /** Live recorded duration in ms: banked time plus the current running span. */
  private elapsedRecordedMs(now: number): number {
    const base = this.snapshot.recordedMs ?? 0;
    return this.snapshot.runningSince ? base + Math.max(0, now - this.snapshot.runningSince) : base;
  }

  /**
   * Computes the timer fields for a derived-phase change: (re)start counting on the
   * first entry into `recording`, keep them on a `recording` re-broadcast, and
   * freeze the running span (bank it, stop the clock) for every other phase. Keyed
   * on the *derived* phase, compared against the current (pre-update) phase.
   */
  private nextTimer(newPhase: RecordingSessionSnapshot['phase'], now: number): Pick<RecordingSessionSnapshot, 'recordedMs' | 'runningSince'> {
    if (newPhase === 'recording') {
      return this.snapshot.phase === 'recording'
        ? { recordedMs: this.snapshot.recordedMs, runningSince: this.snapshot.runningSince }
        : { recordedMs: 0, runningSince: now };
    }
    return { recordedMs: this.elapsedRecordedMs(now), runningSince: undefined };
  }

  /**
   * Applies an offscreen phase update onto the canonical background-owned snapshot.
   * This is the **status plane**: a non-terminal report writes only `observed`
   * (never `desired`), so a late same-run report cannot overwrite intent — e.g.
   * after `markStopping` (desired=idle), a late `recording` re-broadcast derives to
   * `stopping`, not back to `recording`. Cross-run stale status is already dropped
   * by the epoch fence (ADR-0003) before reaching here.
   *
   * The update is a typed `OffscreenPhaseUpdate` produced by our own offscreen
   * code, so it is trusted as-is — no defensive normalization.
   */
  applyOffscreenPhase(update: OffscreenPhaseUpdate): RecordingSessionSnapshot {
    const { phase: reported, error, uploadSummary, warnings, tabResolution, capturedDevices } = update;

    // A fenced same-run `idle` is a genuine end-of-run — the offscreen finalized,
    // whether we commanded the stop or capture ended on its own — so finalize and
    // surface the upload summary. (Cross-run stale `idle` never reaches here: the
    // epoch fence drops it first, ADR-0003.)
    if (reported === 'idle') {
      return this.markIdle(uploadSummary, warnings);
    }

    if (reported === 'failed') {
      this.snapshot.warnings = warnings;
      return this.fail(error ?? 'Recording runtime failed');
    }

    const now = Date.now();
    const desired = this.snapshot.desired ?? 'idle';
    const failed = this.snapshot.failed ?? false;
    const observed: ObservedState = reported;
    const phase = projectPhase(desired, observed, failed);
    this.snapshot = {
      phase,
      desired,
      observed,
      failed,
      runConfig: this.snapshot.runConfig,
      targetTabId: this.snapshot.targetTabId,
      meetingSlug: this.snapshot.meetingSlug,
      historyId: this.snapshot.historyId,
      error,
      warnings,
      micMuted: this.snapshot.micMuted,
      cameraMuted: this.snapshot.cameraMuted,
      paused: this.snapshot.paused,
      tabResolution: tabResolution ?? this.snapshot.tabResolution,
      capturedDevices: capturedDevices ?? this.snapshot.capturedDevices,
      ...this.nextTimer(phase, now),
      uploadSummary: undefined,
      epoch: this.snapshot.epoch,
      uploadJobs: this.snapshot.uploadJobs,
      updatedAt: now,
    };
    return this.commit();
  }

  /**
   * Inserts or updates a background upload job (ADR-0004). Jobs are keyed by id and
   * phase-independent — preserved across recording starts and idle — so this merges
   * by id without touching the recording planes or the displayed phase.
   */
  upsertUploadJob(job: UploadJob): RecordingSessionSnapshot {
    const existing = this.snapshot.uploadJobs ?? [];
    const next = existing.some((j) => j.id === job.id)
      ? existing.map((j) => (j.id === job.id ? job : j))
      : [...existing, job];
    this.snapshot = { ...this.snapshot, uploadJobs: next, updatedAt: Date.now() };
    return this.commit();
  }

  /** Drops a background upload job (e.g. once a finished job's tab is dismissed). */
  removeUploadJob(id: string): RecordingSessionSnapshot {
    const next = (this.snapshot.uploadJobs ?? []).filter((j) => j.id !== id);
    this.snapshot = {
      ...this.snapshot,
      uploadJobs: next.length ? next : undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Resolves only after every snapshot change issued so far reached durable session storage. */
  async flush(): Promise<void> {
    await this.persistenceTail;
  }

  /** Persists and broadcasts the latest session snapshot. */
  private commit(): RecordingSessionSnapshot {
    const snapshot = this.getSnapshot();
    const write = this.persistenceTail.catch(() => {}).then(async () => {
      await this.persist(snapshot);
    });
    this.persistenceTail = write;
    // Most callers intentionally update UI optimistically. Keep their behavior
    // while exposing flush() to the upload outbox acknowledgement path.
    void write.catch(() => {});
    this.onChanged?.(snapshot);
    return snapshot;
  }
}
