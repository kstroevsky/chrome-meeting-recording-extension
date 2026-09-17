/**
 * @file offscreen/analysis/AnalysisManager.ts
 *
 * Runs topic analysis as a background job in the data plane (HOST-01…04),
 * structurally the same thing `UploadManager` is for Drive uploads: a queue at
 * concurrency 1, a job whose state is reported as it moves, and a terminal
 * state that survives the service worker dying underneath it.
 *
 * **Concurrency is 1 and not configurable.** Two analyses would contend for one
 * GPU and one model, and the second would not finish sooner for having started
 * — while a live capture running alongside would feel both. Uploads take the
 * same default for the same reason; here it is a hard limit rather than a
 * default.
 *
 * **The engine is opened on demand and released when the queue drains.** A
 * loaded ONNX graph holds GPU buffers, and analysis is a rare per-recording
 * event rather than a steady-state service, so holding the model resident
 * between recordings would cost memory for the whole session to save a load
 * that happens a handful of times. This is also the instinct RES-01 states for
 * the deferred two-model case, arrived at independently here.
 *
 * **The result is not durable, the job state is.** A completed analysis is held
 * in memory until the background acknowledges it, and is recomputed if this
 * document dies first. That is proportionate: unlike upload bytes, an analysis
 * is derived data the transcript can always reproduce, and the reconnect
 * window is seconds — a disconnected port wakes the service worker on the
 * offscreen's next connect attempt.
 */

import { analyzeTranscript, type AnalysisResult } from '../../shared/analysis/analyzeTranscript';
import type { AnalysisJob } from '../../shared/analysis/job';
import type { AnalysisProvenance } from '../../shared/analysis/provenance';
import type { AnalysisConfig } from '../../shared/analysis/types';
import type { TranscriptSegment } from '../../shared/transcript';
import type { EmbeddingWorkerClient } from './EmbeddingWorkerClient';
import { describeRuntimeError } from '../errors';

/** What the manager needs to open an engine; supplied so tests need no worker. */
export type EmbeddingEngineFactory = () => Promise<EmbeddingWorkerClient>;

export type AnalysisManagerDeps = {
  /** Opens an embedding engine. Called at most once per drained queue. */
  openEngine: EmbeddingEngineFactory;
  /** Sink for a job's latest state; the offscreen posts it to background. */
  report: (job: AnalysisJob) => void | Promise<void>;
  /**
   * Hands a completed analysis to the control plane, which persists it.
   * Resolves once the background has taken ownership; a rejection leaves the
   * result held here for the next replay.
   */
  deliver: (job: AnalysisJob, result: AnalysisResult, provenance: AnalysisProvenance) => Promise<void>;
  now?: () => number;
  genId?: () => string;
  warn?: (...args: unknown[]) => void;
  /** True when the engine path is latched unusable; jobs then end `unsupported`. */
  isUnsupported?: () => boolean;
};

type AnalysisTask = {
  job: AnalysisJob;
  transcript: TranscriptSegment[];
  config: AnalysisConfig;
  /** What the control plane captured at enqueue; returned with the result. */
  provenance: AnalysisProvenance;
  controller: AbortController;
};

type HeldResult = { job: AnalysisJob; result: AnalysisResult; provenance: AnalysisProvenance };

export class AnalysisManager {
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly pending: AnalysisTask[] = [];
  private readonly tasks = new Map<string, AnalysisTask>();
  /** Completed results awaiting a background ack; see the file docblock. */
  private readonly undelivered = new Map<string, HeldResult>();
  private engine: EmbeddingWorkerClient | null = null;
  private active = 0;
  private seq = 0;

  constructor(private readonly deps: AnalysisManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.genId = deps.genId ?? (() => `ana_${this.now()}_${(this.seq += 1)}`);
  }

  /**
   * Queues one recording's transcript for analysis and returns the job id.
   *
   * Reports the job's initial `analyzing` state immediately, so a surface can
   * show the run before the model has finished loading — which on a cold WASM
   * machine is the longest part of it.
   */
  enqueue(
    historyId: string,
    transcript: TranscriptSegment[],
    config: AnalysisConfig,
    provenance: AnalysisProvenance,
  ): string {
    const job: AnalysisJob = {
      id: this.genId(),
      historyId,
      status: 'analyzing',
      progress: 0,
      startedAt: this.now(),
    };
    const task: AnalysisTask = { job, transcript, config, provenance, controller: new AbortController() };
    this.pending.push(task);
    this.tasks.set(job.id, task);
    void this.emit(job);
    this.pump();
    return job.id;
  }

  /** Aborts a queued or running job; it stops at the next batch boundary. */
  cancel(jobId: string): boolean {
    const task = this.tasks.get(jobId);
    if (!task || task.controller.signal.aborted) return false;
    task.controller.abort();
    return true;
  }

  /**
   * True while any job is queued, running, **or holding an unacknowledged
   * result** — the HOST-04 "busy" check.
   *
   * The last clause is the one that is easy to miss. A job reports `completed`
   * before its result has been delivered and persisted, so a busy check that
   * watched only running jobs would go quiet while the only copy of an
   * analysis still lived in this document's memory — and an extension update
   * arriving in that window would discard it.
   */
  hasActiveJobs(): boolean {
    return this.tasks.size > 0 || this.undelivered.size > 0;
  }

  /** How many completed results are still waiting to be acknowledged. */
  undeliveredCount(): number {
    return this.undelivered.size;
  }

  /** Queued and running jobs. */
  activeJobs(): AnalysisJob[] {
    return [...this.tasks.values()].map((task) => ({ ...task.job }));
  }

  /**
   * Every job that still makes this document busy — queued, running, **and**
   * completed with a result nobody has acknowledged.
   *
   * What replay and the busy query must use. `activeJobs` alone omits a held
   * result, and a held result whose outbox write also failed would then be
   * invisible to a reconnecting background: present in memory, announced
   * nowhere, and destroyed by the next update.
   */
  busyJobs(): AnalysisJob[] {
    return [
      ...this.activeJobs(),
      ...[...this.undelivered.values()].map((held) => ({ ...held.job })),
    ];
  }

  /** Whether a completed job's result is still held here. */
  holdsResult(jobId: string): boolean {
    return this.undelivered.has(jobId);
  }

  /**
   * Re-attempts delivery of every completed-but-unacknowledged result.
   *
   * Called when a port reconnects. Separate from the outbox, which carries the
   * job's *state*: this carries its payload, which is why it is in memory.
   */
  async redeliver(): Promise<void> {
    for (const [jobId, held] of [...this.undelivered]) {
      try {
        await this.deps.deliver(held.job, held.result, held.provenance);
        // Deliberately **not** deleted here. `deliver` is a `postMessage`: it
        // resolves when the message left, which says nothing about whether the
        // background persisted anything. Releasing on a successful send loses
        // the only copy of a result whenever the control plane dies, or its
        // IndexedDB write fails, in the interval between the two.
        //
        // `acknowledge()` is the single release point, and it is called only
        // after the row is on disk.
      } catch (error) {
        this.deps.warn?.('Could not deliver analysis result', jobId, describeRuntimeError(error));
        return;
      }
    }
  }

  /** Drops a held result once the background says it owns it. */
  acknowledge(jobId: string): void {
    this.undelivered.delete(jobId);
  }

  private pump(): void {
    // Concurrency 1, deliberately: see the file docblock.
    while (this.active < 1 && this.pending.length > 0) {
      const next = this.pending.shift()!;
      this.active += 1;
      void this.run(next).finally(() => {
        this.active -= 1;
        this.tasks.delete(next.job.id);
        if (this.pending.length === 0) this.releaseEngine();
        this.pump();
      });
    }
  }

  private async run(task: AnalysisTask): Promise<void> {
    const { config, controller, transcript } = task;

    if (this.deps.isUnsupported?.()) {
      await this.settleTerminal(task, {
        status: 'unsupported',
        error: 'This machine cannot run topic analysis.',
      });
      return;
    }

    try {
      const engine = await this.acquireEngine();
      task.job = { ...task.job, device: engine.info.device };
      await this.emit(task.job);

      const result = await analyzeTranscript(transcript, config, engine.encoder(), {
        signal: controller.signal,
        onProgress: ({ windowsEncoded, windowsTotal }) => {
          task.job = {
            ...task.job,
            status: 'analyzing',
            windowsEncoded,
            windowsTotal,
            progress: windowsTotal > 0 ? windowsEncoded / windowsTotal : 0,
          };
          void this.emit(task.job);
        },
      });

      if (controller.signal.aborted) {
        await this.settleTerminal(task, { status: 'canceled' });
        return;
      }

      const completed: AnalysisJob = {
        ...task.job,
        status: 'completed',
        progress: 1,
        topicCount: result.topics.length,
        segmentCount: result.segments.length,
        finishedAt: this.now(),
      };
      task.job = completed;
      // Held before reporting, so a terminal state can never reach the
      // background without its payload being available to follow it.
      this.undelivered.set(completed.id, {
        job: completed,
        result,
        // The backend is only known now, so it is stamped here onto the
        // conditions the control plane captured before the run began.
        provenance: { ...task.provenance, embeddingDevice: engine.info.device },
      });
      await this.emit(completed);
      await this.redeliver();
    } catch (error) {
      if (controller.signal.aborted) {
        await this.settleTerminal(task, { status: 'canceled' });
        return;
      }
      const message = describeRuntimeError(error);
      this.deps.warn?.('Analysis job failed', task.job.historyId, message);
      // An engine that threw may be wedged; drop it so the next job opens a
      // fresh one rather than inheriting the fault.
      this.releaseEngine();
      await this.settleTerminal(task, {
        status: this.deps.isUnsupported?.() ? 'unsupported' : 'failed',
        error: message,
      });
    }
  }

  private async settleTerminal(
    task: AnalysisTask,
    patch: { status: AnalysisJob['status']; error?: string },
  ): Promise<void> {
    const settled: AnalysisJob = {
      ...task.job,
      ...patch,
      finishedAt: this.now(),
    };
    task.job = settled;
    await this.emit(settled);
  }

  private async acquireEngine(): Promise<EmbeddingWorkerClient> {
    if (this.engine) return this.engine;
    this.engine = await this.deps.openEngine();
    return this.engine;
  }

  private releaseEngine(): void {
    const engine = this.engine;
    this.engine = null;
    try {
      engine?.dispose();
    } catch (error) {
      this.deps.warn?.('Could not dispose the embedding engine', describeRuntimeError(error));
    }
  }

  private async emit(job: AnalysisJob): Promise<void> {
    try {
      await this.deps.report(job);
    } catch (error) {
      // Transport failure must never change the job's outcome; the outbox
      // replays terminal state after reconnect.
      this.deps.warn?.('Could not report analysis state', job.id, describeRuntimeError(error));
    }
  }
}
