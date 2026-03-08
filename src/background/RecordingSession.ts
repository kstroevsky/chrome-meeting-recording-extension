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
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadSummary,
} from '../shared/recording';

type SessionChangeListener = (snapshot: RecordingSessionSnapshot) => void;
type SessionPersistor = (snapshot: RecordingSessionSnapshot) => Promise<void> | void;

export class RecordingSession {
  private snapshot: RecordingSessionSnapshot = createIdleSession();

  constructor(
    private readonly persist: SessionPersistor,
    private readonly onChanged?: SessionChangeListener
  ) {}

  hydrate(value: unknown): RecordingSessionSnapshot {
    this.snapshot = normalizeSessionSnapshot(value);
    return this.commit();
  }

  getSnapshot(): RecordingSessionSnapshot {
    return cloneSession(this.snapshot);
  }

  start(runConfig: RecordingRunConfig): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'starting',
      runConfig,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  markStopping(): RecordingSessionSnapshot {
    return this.transition('stopping');
  }

  markRecording(): RecordingSessionSnapshot {
    return this.transition('recording');
  }

  markUploading(): RecordingSessionSnapshot {
    return this.transition('uploading');
  }

  markIdle(uploadSummary?: UploadSummary): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'idle',
      runConfig: null,
      uploadSummary: normalizeUploadSummary(uploadSummary),
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  fail(error: string): RecordingSessionSnapshot {
    this.snapshot = {
      phase: 'failed',
      runConfig: this.snapshot.runConfig,
      error,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  applyOffscreenPhase(update: {
    phase: unknown;
    uploadSummary?: unknown;
    error?: unknown;
  }): RecordingSessionSnapshot {
    const phase = normalizePhase(update.phase);
    const error = typeof update.error === 'string' && update.error.trim() ? update.error : undefined;
    const uploadSummary = normalizeUploadSummary(update.uploadSummary);

    if (phase === 'idle') {
      return this.markIdle(uploadSummary);
    }

    if (phase === 'failed') {
      return this.fail(error ?? 'Recording runtime failed');
    }

    this.snapshot = {
      phase,
      runConfig: this.snapshot.runConfig,
      error,
      uploadSummary: undefined,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  private transition(phase: RecordingSessionSnapshot['phase']): RecordingSessionSnapshot {
    this.snapshot = {
      phase,
      runConfig: this.snapshot.runConfig,
      updatedAt: Date.now(),
    };
    return this.commit();
  }

  private commit(): RecordingSessionSnapshot {
    const snapshot = this.getSnapshot();
    this.persist(snapshot);
    this.onChanged?.(snapshot);
    return snapshot;
  }
}

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
    updatedAt: snapshot.updatedAt,
  };
}
