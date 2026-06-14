/**
 * @file background/RecordingSession.ts
 *
 * Canonical session state machine for the recording control plane. Background
 * owns this snapshot and persists it across service worker restarts.
 */

import {
  createIdleSession,
  normalizeSessionSnapshot,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadSummary,
} from '../shared/recording';
import type { OffscreenPhaseUpdate } from '../shared/protocol';

export type RecordingTarget = {
  targetTabId: number;
  meetingSlug?: string;
};

export type SessionChangeListener = (snapshot: RecordingSessionSnapshot) => void;
export type SessionPersistor = (snapshot: RecordingSessionSnapshot) => Promise<void> | void;

/**
 * Canonical state machine for a recording session.
 *
 * Valid phase transitions:
 *
 *   idle  ──start()──►  starting  ──markRecording()──►  recording
 *                                                            │
 *                                              markStopping()▼
 *                                                         stopping
 *                                                            │
 *                                              markUploading()▼
 *                                                         uploading
 *                                                            │
 *                                                markIdle()  ▼
 *                                                          idle
 *
 *   Any non-idle phase ──fail()──► failed
 *   failed             ──start()──► starting   (retry)
 *
 *   applyOffscreenPhase() drives the same transitions but from offscreen-sourced
 *   state updates. It delegates to markIdle() or fail() for terminal phases.
 *
 *   markIdle() carries the optional UploadSummary from the completed upload pass.
 *   fail() preserves the last active runConfig so the popup can display context.
 */
export class RecordingSession {
  private snapshot: RecordingSessionSnapshot = createIdleSession();

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

  /** Starts a new session in the `starting` phase with the chosen run configuration and target tab. */
  start(runConfig: RecordingRunConfig, target?: RecordingTarget): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'starting',
      runConfig,
      targetTabId: target?.targetTabId,
      meetingSlug: target?.meetingSlug,
      warnings: undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Marks the session as actively stopping recorder instances. */
  markStopping(): RecordingSessionSnapshot {
    return this.transition('stopping');
  }

  /** Marks the session as actively recording. */
  markRecording(): RecordingSessionSnapshot {
    return this.transition('recording');
  }

  /** Marks the session as uploading sealed artifacts after capture stops. */
  markUploading(): RecordingSessionSnapshot {
    return this.transition('uploading');
  }

  /** Clears run state and moves the session back to idle. */
  markIdle(uploadSummary?: UploadSummary, warnings?: string[]): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'idle',
      runConfig: null,
      uploadSummary,
      warnings,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Records a terminal failure while preserving the last active run configuration. */
  fail(error: string): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'failed',
      runConfig: this.snapshot.runConfig,
      targetTabId: this.snapshot.targetTabId,
      meetingSlug: this.snapshot.meetingSlug,
      error,
      warnings: this.snapshot.warnings,
      micMuted: this.snapshot.micMuted,
      updatedAt: Date.now(),
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

  /**
   * Applies an offscreen phase update onto the canonical background-owned
   * snapshot. The update is a typed `OffscreenPhaseUpdate` produced by our own
   * offscreen code, so it is trusted as-is — no defensive normalization.
   */
  applyOffscreenPhase(update: OffscreenPhaseUpdate): RecordingSessionSnapshot {
    const { phase, error, uploadSummary, warnings } = update;

    if (phase === 'idle') {
      return this.markIdle(uploadSummary, warnings);
    }

    if (phase === 'failed') {
      this.snapshot.warnings = warnings;
      return this.fail(error ?? 'Recording runtime failed');
    }

    this.snapshot = {
      phase,
      runConfig: this.snapshot.runConfig,
      targetTabId: this.snapshot.targetTabId,
      meetingSlug: this.snapshot.meetingSlug,
      error,
      warnings,
      micMuted: this.snapshot.micMuted,
      uploadSummary: undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Performs simple phase-only transitions while preserving the active run config. */
  private transition(phase: RecordingSessionSnapshot['phase']): RecordingSessionSnapshot {
    this.snapshot = {
      phase,
      runConfig: this.snapshot.runConfig,
      targetTabId: this.snapshot.targetTabId,
      meetingSlug: this.snapshot.meetingSlug,
      warnings: this.snapshot.warnings,
      micMuted: this.snapshot.micMuted,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Persists and broadcasts the latest session snapshot. */
  private commit(): RecordingSessionSnapshot {
    const snapshot = this.getSnapshot();
    this.persist(snapshot);
    this.onChanged?.(snapshot);
    return snapshot;
  }
}
