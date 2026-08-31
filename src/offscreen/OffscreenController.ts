/**
 * @file offscreen/OffscreenController.ts
 *
 * Phase/warning state machine and stop→finalize coordinator for the offscreen
 * document. Extracted from the offscreen.ts entrypoint so the control logic —
 * which phase to broadcast, when to dedupe warnings, and how the stop pipeline
 * sequences engine.stop → upload/save → idle — can be unit-tested without a live
 * offscreen page, port, or DOM. The entrypoint keeps only the chrome port wiring,
 * the runtime sampler timer, and the concrete engine/finalizer construction.
 */

import { describeRuntimeError } from './errors';
import type { OffscreenPhaseUpdate } from '../shared/protocol';
import {
  DEFAULT_RECORDING_RUN_CONFIG,
  type RecordingPhase,
  type RecordingCaptureDevices,
  type RecordingArtifactContext,
  type RecordingRunConfig,
  type StorageMode,
  type UploadSummary,
} from '../shared/recording';
import type { CompletedRecordingArtifact } from './engine/RecorderEngineTypes';

/** The run's notes, rendered to WebVTT by the background, which owns them. */
export type NotesSidecar = { vtt: string };

/**
 * Wraps the rendered VTT as an artifact the finalizer can deliver like any
 * other. The name is derived from a media artifact rather than sent with the
 * text, so filenames stay built in one place. It has no OPFS source — it was
 * never captured — so `cleanup` is a no-op and crash recovery has nothing to
 * reclaim.
 */
function notesArtifact(
  { vtt }: NotesSidecar,
  media: CompletedRecordingArtifact[],
): CompletedRecordingArtifact | null {
  const source = media[0]?.artifact.filename;
  if (!source) return null;
  const filename = `${source.replace(/-(recording|mic|self-video)\.[a-z0-9]+$/i, '')}-notes.vtt`;
  const file = new File([vtt], filename, { type: 'text/vtt' });
  return {
    stream: media[0].stream,
    kind: 'notes',
    artifact: { filename, file, mimeType: 'text/vtt', cleanup: async () => {} },
  };
}
import type { RuntimeSampler } from './RuntimeSampler';

export type OffscreenStateMessage = { type: 'OFFSCREEN_STATE' } & OffscreenPhaseUpdate;

/** The slice of RecorderEngine the finalize pipeline needs. */
export interface FinalizableEngine {
  stop(): Promise<CompletedRecordingArtifact[]>;
}

/** The slice of RecordingFinalizer the finalize pipeline needs. */
export interface ArtifactFinalizer {
  finalize(args: {
    artifacts: CompletedRecordingArtifact[];
    storageMode: StorageMode;
    historyId?: string;
  }): Promise<UploadSummary | undefined>;
}

export type OffscreenControllerDeps = {
  /** Sink that delivers an OFFSCREEN_STATE message to the background port. */
  postMessage: (message: OffscreenStateMessage) => void;
  sampler: Pick<RuntimeSampler, 'markActivePhaseStart'>;
  error: (...args: unknown[]) => void;
  onWarning?: (warning: string) => void;
  onFinalizeFailed?: (error: unknown) => void;
  /** Monotonic clock; defaults to Date.now for tests. */
  now?: () => number;
};

export class OffscreenController {
  private phase: RecordingPhase = 'idle';
  private warnings: string[] = [];
  private storageMode: StorageMode = DEFAULT_RECORDING_RUN_CONFIG.storageMode;
  private historyId: string | undefined;
  private telemetryRunId: string | undefined;
  /** Device labels from the tracks opened for the active run. */
  private capturedDevices: RecordingCaptureDevices | undefined;
  /** Run epoch from the latest OFFSCREEN_START; echoed in every OFFSCREEN_STATE (ADR-0003). */
  private epoch = 0;
  private finalizeRunPromise: Promise<void> | null = null;
  private engine: FinalizableEngine | null = null;
  private finalizer: ArtifactFinalizer | null = null;
  private enqueueUpload: ((artifacts: CompletedRecordingArtifact[], context: RecordingArtifactContext) => void) | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: OffscreenControllerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Wires the recording engine and finalizer used by the stop/finalize pipeline.
   * `enqueueUpload` (ADR-0004) detaches Drive uploads into a background job manager;
   * when omitted, Drive uploads finalize inline (the legacy single-session path).
   */
  attachServices(
    engine: FinalizableEngine,
    finalizer: ArtifactFinalizer,
    enqueueUpload?: (artifacts: CompletedRecordingArtifact[], context: RecordingArtifactContext) => void
  ): void {
    this.engine = engine;
    this.finalizer = finalizer;
    this.enqueueUpload = enqueueUpload ?? null;
  }

  currentPhase = (): RecordingPhase => this.phase;
  currentEpoch = (): number => this.epoch;
  currentWarnings = (): string[] => this.warnings;
  isFinalizing = (): boolean => this.finalizeRunPromise !== null;
  clearWarnings = (): void => { this.warnings = []; };

  onStartRequested = (_runConfig: RecordingRunConfig, storageMode: StorageMode, epoch: number, historyId: string, telemetryRunId?: string): void => {
    this.storageMode = storageMode;
    this.epoch = epoch;
    this.historyId = historyId || undefined;
    this.telemetryRunId = telemetryRunId || undefined;
    this.capturedDevices = undefined;
  };

  /** Stores a delivered input-device label and re-broadcasts the active phase. */
  reportCaptureDevices = (devices: RecordingCaptureDevices): void => {
    this.capturedDevices = { ...this.capturedDevices, ...devices };
    if (this.phase !== 'idle') this.pushState(this.phase);
  };

  onStopRequested = (notesSidecar?: NotesSidecar): void => { void this.finalize(notesSidecar); };
  onDiscardRequested = (): Promise<void> => this.discard();

  /** Advances the broadcast phase, rebaselining the lag clock on a new active phase. */
  pushState = (
    phase: RecordingPhase,
    extra?: Pick<OffscreenPhaseUpdate, 'uploadSummary' | 'error' | 'tabResolution'>
  ): void => {
    if (phase !== this.phase && phase !== 'idle') {
      this.deps.sampler.markActivePhaseStart(this.now());
    }
    this.phase = phase;
    if (phase === 'idle') this.capturedDevices = undefined;
    this.deps.postMessage({
      type: 'OFFSCREEN_STATE',
      phase,
      epoch: this.epoch,
      ...(this.warnings.length ? { warnings: this.warnings } : {}),
      ...(this.capturedDevices ? { capturedDevices: this.capturedDevices } : {}),
      ...(extra ?? {}),
    });
  };

  /** Records a de-duplicated, trimmed warning and re-broadcasts the current phase. */
  reportWarning = (warning: string): void => {
    const normalized = warning.trim();
    if (!normalized || this.warnings.includes(normalized)) return;
    this.warnings = [...this.warnings, normalized];
    this.deps.onWarning?.(normalized);
    this.pushState(this.phase);
  };

  /**
   * Stops capture, uploads or saves the sealed artifacts, and returns the
   * session to idle. Concurrent calls share one in-flight run.
   */
  finalize(notesSidecar?: NotesSidecar): Promise<void> {
    if (this.finalizeRunPromise) return this.finalizeRunPromise;
    const engine = this.engine;
    const finalizer = this.finalizer;
    if (!engine || !finalizer) {
      throw new Error('OffscreenController.attachServices must be called before finalize');
    }

    this.finalizeRunPromise = (async () => {
      const artifacts = await engine.stop();
      // Notes lead the delivery: a reader has them while the video is still
      // uploading, which is the whole point of sending them first (ADR-0005).
      if (artifacts.length > 0 && notesSidecar) {
        const notes = notesArtifact(notesSidecar, artifacts);
        if (notes) artifacts.unshift(notes);
      }
      if (artifacts.length > 0) {
        if (this.storageMode === 'drive') {
          // ADR-0004: capture is sealed — hand it to the background upload manager
          // and return to idle at once so a new recording can start while it uploads.
          if (!this.enqueueUpload) throw new Error('Drive finalize requires an upload manager');
          this.enqueueUpload(artifacts, { historyId: this.historyId, telemetryRunId: this.telemetryRunId });
        } else {
          // Local saves are instant; finalize inline.
          await finalizer.finalize({ artifacts, storageMode: 'local', historyId: this.historyId });
        }
      }
      this.pushState('idle');
    })()
      .catch((e) => {
        this.deps.error('Stop/finalize pipeline failed', describeRuntimeError(e));
        this.deps.onFinalizeFailed?.(e);
        this.pushState('failed', { error: describeRuntimeError(e) });
      })
      .finally(() => {
        this.finalizeRunPromise = null;
      });

    return this.finalizeRunPromise;
  }

  /**
   * Stops capture and removes the sealed temporary artifacts. Unlike `finalize`,
   * this intentionally never calls the local finalizer or upload queue, so discard
   * cannot create a download, Drive upload, or retained upload job.
   */
  discard(): Promise<void> {
    if (this.finalizeRunPromise) return this.finalizeRunPromise;
    const engine = this.engine;
    if (!engine) throw new Error('OffscreenController.attachServices must be called before discard');

    this.finalizeRunPromise = (async () => {
      let artifacts = await engine.stop();
      try {
        const cleanup = await Promise.allSettled(artifacts.map(({ artifact }) => artifact.cleanup()));
        const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) {
          throw new Error(
            `Failed to delete ${failures.length} discarded recording artifact(s): `
            + failures.map(({ reason }) => describeRuntimeError(reason)).join('; ')
          );
        }
      } finally {
        // Do not retain Blob/File references after cleanup; this makes their backing
        // buffers collectible as soon as the discard command completes.
        artifacts = [];
      }
      this.pushState('idle');
    })()
      .catch((e) => {
        this.deps.error('Discard pipeline failed', describeRuntimeError(e));
        this.pushState('failed', { error: describeRuntimeError(e) });
        throw e;
      })
      .finally(() => {
        this.finalizeRunPromise = null;
      });

    return this.finalizeRunPromise;
  }
}
