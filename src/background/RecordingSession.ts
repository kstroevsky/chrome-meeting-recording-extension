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
  type RecordingInterruption,
  type RecordingSessionSnapshot,
  type UploadJob,
  type UploadSummary,
} from '../shared/recording';
import { MAX_RECORDED_SPANS, type RecordedSpan } from '../shared/recordingTypes';
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
  /** Set at an interrupted stop; carried onto the snapshot until dismissed. */
  private pendingInterruption?: RecordingInterruption;

  private snapshot: RecordingSessionSnapshot = createIdleSession();
  private persistenceTail: Promise<void> = Promise.resolve();

  /** Builds the canonical session state machine around persistence and change notifications. */
  constructor(
    private readonly persist: SessionPersistor,
    private readonly onChanged?: SessionChangeListener,
    /**
     * Fired once when a run ends, with its final recorded duration — the seam
     * downstream data uses to seal anything the run left open (ADR-0005).
     */
    private readonly onRunFinished?: (historyId: string, durationMs: number) => void
  ) {}

  /** Hydrates the in-memory session from previously persisted snapshot data. */
  hydrate(value: unknown): RecordingSessionSnapshot {
    this.snapshot = normalizeSessionSnapshot(value);
    return this.commit();
  }

  /** Clears the interruption notice once the user has seen it. */
  dismissInterruption(): RecordingSessionSnapshot {
    this.pendingInterruption = undefined;
    this.snapshot = { ...this.snapshot, interruption: undefined, updatedAt: Date.now() };
    return this.commit();
  }

  /** Returns a defensive clone of the current session snapshot. */
  getSnapshot(): RecordingSessionSnapshot {
    return structuredClone(this.snapshot);
  }

  /** Starts a new session with the chosen run configuration and target tab (desired=recording). */
  start(runConfig: RecordingRunConfig, target?: RecordingTarget): RecordingSessionSnapshot {
    this.pendingInterruption = undefined;
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
      interruption: undefined,
      warnings: undefined,
      // Fencing token (ADR-0003): a fresh, strictly-increasing epoch per run.
      epoch: (this.snapshot.epoch ?? 0) + 1,
      // The previous run's span ledger is not this run's timeline.
      recordedSpans: undefined,
      // Background uploads outlive the run that spawned them (ADR-0004): carry any
      // still-uploading jobs into the new recording so starting one never drops them,
      // while pruning finished tabs so the list can't grow without bound.
      uploadJobs: carriedUploads?.length ? carriedUploads : undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Signals intent to stop (desired=idle); the phase derives to `stopping` while capture drains. */
  markStopping(interruption?: RecordingInterruption['reason']): RecordingSessionSnapshot {
    const now = Date.now();
    const { historyId } = this.snapshot;
    // Captured before the timer is banked so the reported position is the one
    // the capture actually reached.
    const atMs = this.elapsedRecordedMs(now);
    this.rememberFinishedRun(now);
    if (interruption && historyId) {
      this.pendingInterruption = { reason: interruption, atMs, historyId };
    }
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
      interruption: this.pendingInterruption ?? this.snapshot.interruption,
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
      // The span ledger outlives its run too (ADR-0007): the transcript sweep
      // runs *after* the session is idle, and without the ledger it would have
      // no way to place the words the run's last seconds produced. Reset by the
      // next `start()`, not by going idle.
      recordedSpans: closeOpenSpan(this.snapshot.recordedSpans, Date.now()),
      // Background upload jobs are phase-independent (ADR-0004): an idle session
      // can still have uploads draining from the recording that just ended.
      uploadJobs: this.snapshot.uploadJobs,
      // An interruption outlives its run: the capture is saved, and the popup
      // still has to report what happened (design n4).
      interruption: this.pendingInterruption ?? this.snapshot.interruption,
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
    const recordedMs = paused ? this.elapsedRecordedMs(now) : (this.snapshot.recordedMs ?? 0);
    this.snapshot = {
      ...this.snapshot,
      paused: paused || undefined,
      recordedMs,
      runningSince: paused ? undefined : (this.snapshot.runningSince ?? now),
      // A paused span is never written into the media, so the ledger closes
      // here and the resumed span reopens at the banked media offset.
      recordedSpans: paused
        ? closeOpenSpan(this.snapshot.recordedSpans, now)
        : openSpan(this.snapshot.recordedSpans, now, recordedMs),
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
   * Media-relative position for a *past* wall-clock instant, or `undefined`
   * when that instant is not in the produced file.
   *
   * Unlike {@link currentRecordedMs}, which reads the clock now, this projects
   * a remembered moment — a caption committed seconds ago in another context —
   * through the run's span ledger. It therefore keeps working after the run has
   * ended, which is exactly when the transcript sweep needs it, and across
   * pauses, whose spans are absent from the ledger and so map to nothing.
   *
   * Returns `undefined` rather than clamping for anything outside a span:
   * before the run, after it, or inside a paused stretch. Clamping would map
   * those to a real offset and seek to words that are not there.
   */
  recordedMsAt(wallClockMs: number, now: number = Date.now()): number | undefined {
    if (!Number.isFinite(wallClockMs)) return undefined;
    const spans = this.snapshot.recordedSpans;
    // A run already in flight when this ledger shipped has no spans; fall back
    // to the live single-span reading so an upgrade mid-recording still maps.
    if (!spans?.length) return this.legacyRecordedMsAt(wallClockMs);

    const span = spans.find((candidate) => withinSpan(candidate, wallClockMs, now));
    return span ? span.mediaStartMs + (wallClockMs - span.wallStartMs) : undefined;
  }

  /**
   * Projects a wall-clock *range* — an utterance's spoken span — onto the media
   * timeline, or `undefined` when it cannot be placed honestly.
   *
   * A range whose end lies past its span is **always** refused, whether the gap
   * is a pause or the end of the run.
   *
   * `endWallMs` is when the caption's text was last *observed to change*, so an
   * end beyond the span means words arrived after the recorder had stopped
   * writing. Truncating the timestamp would leave those words in the text,
   * anchored to media that does not contain them — attributing post-resume, or
   * post-stop, speech to what came before. No word-level timing exists to say
   * where the text divides, so the caller drops it and counts it.
   *
   * There is nothing to truncate in the ordinary case: an utterance that simply
   * *committed* after the cutoff, having stopped changing before it, ends
   * inside its span and maps whole. Commit time is not part of this range.
   *
   * Refusal should be rare: the caption buffer is drained at both boundaries —
   * when a run pauses and when it stops — so an utterance normally closes on
   * the boundary and anything after it belongs to the next span or to no
   * recording at all. This is the backstop for when that drain does not land: a
   * closed tab, or a caption that changed in the gap before the message arrived.
   */
  recordedRangeAt(
    startWallMs: number,
    endWallMs: number,
    now: number = Date.now(),
  ): { tStartMs: number; tEndMs: number } | undefined {
    const tStartMs = this.recordedMsAt(startWallMs, now);
    if (tStartMs == null) return undefined;

    const spans = this.snapshot.recordedSpans;
    const span = spans?.find((candidate) => withinSpan(candidate, startWallMs, now));
    if (!span) {
      // Legacy single-span path: an end that does not map collapses to a point.
      const tEndMs = this.recordedMsAt(endWallMs, now);
      return { tStartMs, tEndMs: Math.max(tStartMs, tEndMs ?? tStartMs) };
    }

    const spanEndWallMs = span.wallEndMs ?? now;
    if (endWallMs > spanEndWallMs) return undefined;

    // A backwards end is malformed input, not ambiguity: collapse it to a point.
    const boundedEndWallMs = Math.max(endWallMs, startWallMs);
    return { tStartMs, tEndMs: span.mediaStartMs + (boundedEndWallMs - span.wallStartMs) };
  }

  /** The pre-ledger reading: correct only for the currently running span. */
  private legacyRecordedMsAt(wallClockMs: number): number | undefined {
    const { runningSince } = this.snapshot;
    if (runningSince == null || wallClockMs < runningSince) return undefined;
    return (this.snapshot.recordedMs ?? 0) + (wallClockMs - runningSince);
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
    // A run ends once. `markStopping` announces it — capture has stopped there,
    // so the duration is final and open notes can be sealed before the stop RPC
    // carries their export — and the later `markIdle` must not repeat it.
    const alreadyAnnounced = this.lastRun?.historyId === historyId;
    const durationMs = alreadyAnnounced ? this.lastRun!.durationMs : this.elapsedRecordedMs(now);
    this.lastRun = { historyId, durationMs };
    if (!alreadyAnnounced) this.onRunFinished?.(historyId, durationMs);
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
  private nextTimer(
    newPhase: RecordingSessionSnapshot['phase'],
    now: number,
  ): Pick<RecordingSessionSnapshot, 'recordedMs' | 'runningSince' | 'recordedSpans'> {
    if (newPhase === 'recording') {
      return this.snapshot.phase === 'recording'
        ? {
          recordedMs: this.snapshot.recordedMs,
          runningSince: this.snapshot.runningSince,
          recordedSpans: this.snapshot.recordedSpans,
        }
        : { recordedMs: 0, runningSince: now, recordedSpans: openSpan(undefined, now, 0) };
    }
    return {
      recordedMs: this.elapsedRecordedMs(now),
      runningSince: undefined,
      recordedSpans: closeOpenSpan(this.snapshot.recordedSpans, now),
    };
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

/** True when a wall-clock instant falls inside a recorded span. */
function withinSpan(span: RecordedSpan, wallClockMs: number, now: number): boolean {
  if (wallClockMs < span.wallStartMs) return false;
  // An open span reaches only as far as the present; it cannot contain a future.
  return wallClockMs <= (span.wallEndMs ?? now);
}

/** Closes the ledger's open span, if any. Idempotent. */
function closeOpenSpan(spans: RecordedSpan[] | undefined, now: number): RecordedSpan[] | undefined {
  if (!spans?.length) return spans;
  const last = spans[spans.length - 1];
  if (last.wallEndMs != null) return spans;
  return [...spans.slice(0, -1), { ...last, wallEndMs: Math.max(last.wallStartMs, now) }];
}

/**
 * Opens a span at the given media offset. A no-op when one is already open, so
 * a redundant resume cannot fragment the ledger; drops the append at the bound
 * rather than growing without limit, which degrades to unmapped words instead
 * of wrong ones.
 */
function openSpan(spans: RecordedSpan[] | undefined, now: number, mediaStartMs: number): RecordedSpan[] {
  const current = spans ?? [];
  const last = current[current.length - 1];
  if (last && last.wallEndMs == null) return current;
  if (current.length >= MAX_RECORDED_SPANS) return current;
  return [...current, { wallStartMs: now, mediaStartMs }];
}
