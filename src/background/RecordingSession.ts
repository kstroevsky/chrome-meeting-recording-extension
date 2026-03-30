/**
 * @file background/RecordingSession.ts
 *
 * Canonical session state machine for the recording control plane. Background
 * owns this snapshot and persists it across service worker restarts.
 */

import {
  createIdleSession,
  normalizePhase,
  normalizeSessionSnapshot,
  normalizeUploadSummary,
  normalizeWarnings,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadSummary,
} from '../shared/recording';

type SessionChangeListener = (snapshot: RecordingSessionSnapshot) => void;
type SessionPersistor = (snapshot: RecordingSessionSnapshot) => Promise<void> | void;

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
    return cloneSession(this.snapshot);
  }

  /** Starts a new session in the `starting` phase with the chosen run configuration. */
  start(runConfig: RecordingRunConfig): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'starting',
      runConfig,
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
      uploadSummary: normalizeUploadSummary(uploadSummary),
      warnings: normalizeWarnings(warnings),
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Records a terminal failure while preserving the last active run configuration. */
  fail(error: string): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'failed',
      runConfig: this.snapshot.runConfig,
      error,
      warnings: this.snapshot.warnings,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  /** Applies an offscreen phase update onto the canonical background-owned snapshot. */
  applyOffscreenPhase(update: {
    phase: unknown;
    uploadSummary?: unknown;
    error?: unknown;
    warnings?: unknown;
  }): RecordingSessionSnapshot {
    const phase = normalizePhase(update.phase);
    const error = typeof update.error === 'string' && update.error.trim() ? update.error : undefined;
    const uploadSummary = normalizeUploadSummary(update.uploadSummary);
    const warnings = normalizeWarnings(update.warnings);

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
      error,
      warnings,
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
      warnings: this.snapshot.warnings,
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

/** Deep-clones the session snapshot so callers cannot mutate shared state. */
function cloneSession(snapshot: RecordingSessionSnapshot): RecordingSessionSnapshot {
  return {
    phase: snapshot.phase,
    runConfig: snapshot.runConfig ? { ...snapshot.runConfig } : null,
    uploadSummary: snapshot.uploadSummary
      ? {
          uploaded: snapshot.uploadSummary.uploaded.map((entry) => ({ ...entry })),
          localFallbacks: snapshot.uploadSummary.localFallbacks.map((entry) => ({ ...entry })),
        }
      : undefined,
    error: snapshot.error,
    warnings: snapshot.warnings ? [...snapshot.warnings] : undefined,
    updatedAt: snapshot.updatedAt,
  };
}
