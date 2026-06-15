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
  type RecordingRunConfig,
  type StorageMode,
  type UploadSummary,
} from '../shared/recording';
import type { CompletedRecordingArtifact } from './engine/RecorderEngineTypes';
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
  }): Promise<UploadSummary | undefined>;
}

export type OffscreenControllerDeps = {
  /** Sink that delivers an OFFSCREEN_STATE message to the background port. */
  postMessage: (message: OffscreenStateMessage) => void;
  sampler: Pick<RuntimeSampler, 'markActivePhaseStart'>;
  error: (...args: unknown[]) => void;
  onWarning?: (warning: string) => void;
  /** Monotonic clock; defaults to Date.now for tests. */
  now?: () => number;
};

export class OffscreenController {
  private phase: RecordingPhase = 'idle';
  private warnings: string[] = [];
  private storageMode: StorageMode = DEFAULT_RECORDING_RUN_CONFIG.storageMode;
  /** Run epoch from the latest OFFSCREEN_START; echoed in every OFFSCREEN_STATE (ADR-0003). */
  private epoch = 0;
  private finalizeRunPromise: Promise<void> | null = null;
  private engine: FinalizableEngine | null = null;
  private finalizer: ArtifactFinalizer | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: OffscreenControllerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Wires the recording engine and finalizer used by the stop/finalize pipeline. */
  attachServices(engine: FinalizableEngine, finalizer: ArtifactFinalizer): void {
    this.engine = engine;
    this.finalizer = finalizer;
  }

  currentPhase = (): RecordingPhase => this.phase;
  currentEpoch = (): number => this.epoch;
  currentWarnings = (): string[] => this.warnings;
  isFinalizing = (): boolean => this.finalizeRunPromise !== null;
  clearWarnings = (): void => { this.warnings = []; };

  onStartRequested = (_runConfig: RecordingRunConfig, storageMode: StorageMode, epoch: number): void => {
    this.storageMode = storageMode;
    this.epoch = epoch;
  };

  onStopRequested = (): void => { void this.finalize(); };

  /** Advances the broadcast phase, rebaselining the lag clock on a new active phase. */
  pushState = (phase: RecordingPhase, extra?: Pick<OffscreenPhaseUpdate, 'uploadSummary' | 'error'>): void => {
    if (phase !== this.phase && phase !== 'idle') {
      this.deps.sampler.markActivePhaseStart(this.now());
    }
    this.phase = phase;
    this.deps.postMessage({
      type: 'OFFSCREEN_STATE',
      phase,
      epoch: this.epoch,
      ...(this.warnings.length ? { warnings: this.warnings } : {}),
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
  finalize(): Promise<void> {
    if (this.finalizeRunPromise) return this.finalizeRunPromise;
    const engine = this.engine;
    const finalizer = this.finalizer;
    if (!engine || !finalizer) {
      throw new Error('OffscreenController.attachServices must be called before finalize');
    }

    this.finalizeRunPromise = (async () => {
      const artifacts = await engine.stop();
      if (this.storageMode === 'drive' && artifacts.length > 0) {
        this.pushState('uploading');
      }
      const summary = await finalizer.finalize({ artifacts, storageMode: this.storageMode });
      this.pushState('idle', summary ? { uploadSummary: summary } : undefined);
    })()
      .catch((e) => {
        this.deps.error('Stop/finalize pipeline failed', describeRuntimeError(e));
        this.pushState('failed', { error: describeRuntimeError(e) });
      })
      .finally(() => {
        this.finalizeRunPromise = null;
      });

    return this.finalizeRunPromise;
  }
}
