/**
 * @file background/library/analysis/RecordingAnalysisCoordinator.ts
 *
 * The control plane's half of topic analysis (RT-02, HOST-02).
 *
 * **Background reads and writes; offscreen computes.** The data plane never
 * touches `recording-history` — this reads the transcript out of it, hands the
 * segments across the port, and writes the result back when it returns. That
 * keeps one writer for the aggregate, which is the property that makes the
 * whole thing reasonable to think about: an analysis arriving late, twice, or
 * after a service-worker restart cannot race a repository it does not own.
 *
 * **A completed result is acknowledged only after it is stored.** The ack is
 * what lets the offscreen document drop its copy, so sending it first would
 * open a window where the only copy of a finished analysis exists nowhere.
 *
 * **Nothing here may rely on service-worker memory for correctness.** This
 * object is rebuilt empty every time the worker restarts, which the whole
 * architecture assumes happens at any moment. Its maps are caches and
 * optimizations; the facts they cache — whether a recording was deleted, what
 * conditions a run used — are read from durable state or carried with the job.
 */

import { makeLogger } from '../../../shared/logger';
import type { WireAnalysis } from '../../../shared/analysis/storedAnalysis';
import type { AnalysisJob } from '../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import type { AnalysisConfig } from '../../../shared/analysis/types';
import type { Transcript } from '../../../shared/transcript';
import type { RecordingAnalysisService } from './RecordingAnalysisService';
import { AnalysisResultCommitter } from './AnalysisResultCommitter';

const L = makeLogger('background');

/** The offscreen surface this needs, narrowed so tests need no port. */
export interface AnalysisDataPlane {
  ensureReady(): Promise<void>;
  analyzeTranscript(
    historyId: string,
    transcript: Transcript['segments'],
    config: AnalysisConfig,
    provenance: AnalysisProvenance,
  ): Promise<{ ok: boolean; jobId?: string; error?: string }>;
  cancelAnalysis(jobId: string): Promise<{ ok: boolean; error?: string }>;
  acknowledgeAnalysisState(jobId: string): void;
}

export type RecordingAnalysisCoordinatorDeps = {
  dataPlane: AnalysisDataPlane;
  analyses: RecordingAnalysisService;
  /** Reads a recording's persisted transcript; `undefined` when it has none. */
  readTranscript: (historyId: string) => Promise<Transcript | undefined>;
  /**
   * Whether the recording has been **tombstoned** — the durable deletion fence.
   *
   * Tombstoned, not merely absent. History delivery is asynchronous relative
   * to run completion, so an analysis result can legitimately arrive before
   * its history row exists. Treating "no row" as "deleted" would silently
   * drop those results.
   */
  isRecordingDeleted: (historyId: string) => Promise<boolean>;
  /** The §9 values a run should use. Injected so a later settings surface can supply them. */
  config: () => AnalysisConfig;
  /** Notified whenever a job moves, for the surface. */
  onJobChanged?: (job: AnalysisJob) => void;
  /**
   * Fired after a job stops being work anyone is waiting on — acknowledged and
   * released. Analysis settling changes nothing in `RecordingSession`, so this
   * is what lets a caller re-evaluate anything gated on active work, such as a
   * deferred extension reload.
   */
  onSettled?: () => void;
  now?: () => number;
};

/** Why a requested analysis did not start. */
export type AnalysisStartResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'no-transcript' | 'already-analyzed' | 'busy' | 'failed'; error?: string };

export class RecordingAnalysisCoordinator {
  /**
   * The job holding each recording, from enqueue until its outcome is settled —
   * which for `completed` means stored (or discarded) *and* acknowledged, not
   * merely computed. A cache: after a restart it is rebuilt from replayed state.
   */
  private readonly running = new Map<string, string>();
  /** Covers the async enqueue window before a durable offscreen job id exists. */
  private readonly pending = new Set<string>();
  /**
   * Recordings purged by this worker instance — a fast path only. The durable
   * fence is {@link RecordingAnalysisCoordinatorDeps.isRecordingDeleted}.
   */
  private readonly purged = new Set<string>();
  /**
   * Enqueue-time provenance by job, as a fallback for a result that arrives
   * without its own. The authoritative copy travels with the job and comes back
   * with the result, so this only matters for a data plane that predates that.
   */
  private readonly provenanceByJob = new Map<string, AnalysisProvenance>();
  private readonly resultCommitter: AnalysisResultCommitter;

  constructor(private readonly deps: RecordingAnalysisCoordinatorDeps) {
    this.resultCommitter = new AnalysisResultCommitter({
      analyses: deps.analyses,
      isRecordingDeleted: deps.isRecordingDeleted,
      isPurged: (historyId) => this.purged.has(historyId),
      fallbackProvenance: (jobId) => this.provenanceByJob.get(jobId),
      settle: (job) => this.settle(job),
      now: deps.now,
    });
  }

  /**
   * Starts analysis for one recording, unless there is nothing to analyse, one
   * is already in progress, or a current result already exists.
   *
   * `force` skips the freshness check — the recompute path for a changed
   * configuration, where the caller has already decided the stored result is
   * not the one it wants.
   */
  async analyze(historyId: string, options: { force?: boolean } = {}): Promise<AnalysisStartResult> {
    if (this.running.has(historyId) || this.pending.has(historyId)) {
      return { ok: false, reason: 'busy' };
    }
    this.pending.add(historyId);
    try {
      if (!options.force && await this.deps.analyses.get(historyId)) {
        return { ok: false, reason: 'already-analyzed' };
      }

      const transcript = await this.deps.readTranscript(historyId);
      if (!transcript?.segments.length) return { ok: false, reason: 'no-transcript' };

      this.purged.delete(historyId);
      const provenance = this.deps.analyses.provenanceForNewRun();
      await this.deps.dataPlane.ensureReady();
      const response = await this.deps.dataPlane.analyzeTranscript(
        historyId,
        transcript.segments,
        this.deps.config(),
        provenance,
      );
      if (!response.ok || !response.jobId) {
        return { ok: false, reason: 'failed', error: response.error ?? 'The data plane refused the job' };
      }
      this.running.set(historyId, response.jobId);
      this.provenanceByJob.set(response.jobId, provenance);
      return { ok: true, jobId: response.jobId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      L.warn('Could not start topic analysis', historyId, message);
      return { ok: false, reason: 'failed', error: message };
    } finally {
      this.pending.delete(historyId);
    }
  }

  /**
   * Drops a deleted recording's analysis, and stops a running one.
   *
   * The history tombstone is written before this is called and is what
   * actually fences a late result — see `handleResult`. The in-memory marker
   * here only saves a round trip for results arriving to this same worker.
   */
  async purge(historyId: string): Promise<void> {
    this.purged.add(historyId);
    await this.cancel(historyId).catch(() => {});
    await this.deps.analyses.removeAll(historyId);
  }

  /** Aborts a recording's running analysis, if it has one. */
  async cancel(historyId: string): Promise<boolean> {
    const jobId = this.running.get(historyId);
    if (!jobId) return false;
    const response = await this.deps.dataPlane.cancelAnalysis(jobId);
    return response.ok;
  }

  /**
   * Records a job's latest state.
   *
   * `analyzing` and `completed` both hold the recording: a completed job's
   * result is not yet stored, so a second run started in that interval would
   * repeat the whole computation for nothing — and after a reconnect, when
   * delivery can lag by seconds, that interval is not small.
   *
   * The three result-less endings release the recording and are acknowledged
   * here, because nothing else is coming for them and the outbox drains only
   * on acknowledgement.
   */
  async handleJobState(job: AnalysisJob): Promise<void> {
    const lost = job.status === 'failed' && job.lostResult === true;
    const durableStatus = job.status === 'completed' || lost ? 'analyzing' : job.status;
    await this.deps.analyses.recordJobOutcome(
      job,
      durableStatus,
      durableStatus === 'analyzing' ? undefined : job.error,
      this.deps.now?.(),
    );

    if (job.status === 'analyzing' || job.status === 'completed') {
      this.running.set(job.historyId, job.id);
    } else if (lost) {
      // Release the dead job's hold so the replacement can start, but do **not**
      // acknowledge it yet — see `recoverLostResult`.
      if (this.running.get(job.historyId) === job.id) this.running.delete(job.historyId);
    } else {
      this.settle(job);
    }
    this.deps.onJobChanged?.(job);

    if (lost) await this.recoverLostResult(job);
  }

  /**
   * Replaces a result the data plane computed and then lost with its document.
   *
   * **The unacknowledged outbox row is the recovery token.** Acknowledging on
   * arrival would delete the only durable trace of the work while the
   * replacement run existed nowhere yet — and because an acknowledgement also
   * ends the job's claim on the runtime, a reload deferred until "work
   * finishes" could be applied in exactly that gap, destroying a recording's
   * analysis for good.
   *
   * So the row survives until recovery is actually established: a replacement
   * queued, a current result already on disk, or nothing left to analyse. If
   * none of those hold — the data plane refused, or is unreachable — the row
   * stays, and the next reconnect replays it and tries again.
   */
  private async recoverLostResult(job: AnalysisJob): Promise<void> {
    let outcome: AnalysisStartResult;
    try {
      outcome = await this.analyze(job.historyId);
    } catch (error) {
      L.warn('Could not re-run an analysis whose result was lost', job.historyId, error);
      return;
    }

    if (!outcome.ok) {
      // `already-analyzed` and `no-transcript` are recoveries too: one means a
      // current result is on disk, the other that there is nothing left to
      // analyse. `busy` and `failed` are not — the work still has to happen.
      const recovered = outcome.reason === 'already-analyzed' || outcome.reason === 'no-transcript';
      if (!recovered) {
        L.warn(
          `Could not re-run the lost analysis for ${job.historyId} (${outcome.reason}); `
          + 'keeping its durable state so a later reconnect can retry',
        );
        return;
      }
      if (outcome.reason === 'no-transcript') {
        await this.deps.analyses.recordJobOutcome(
          job,
          'unsupported',
          'Analysis cannot be recovered because the recording has no transcript.',
          this.deps.now?.(),
        );
      }
    }
    this.settle(job);
  }

  /**
   * Persists a completed analysis, then releases it.
   *
   * Every exit path acknowledges except one — a transient storage failure —
   * because that is the only case where the same result arriving again could
   * succeed. Everything else is either done, or cannot be fixed by resending.
   */
  async handleResult(job: AnalysisJob, wire: WireAnalysis, wireProvenance?: unknown): Promise<void> {
    await this.resultCommitter.commit(job, wire, wireProvenance);
  }

  /**
   * Ends a job's hold on its recording and acknowledges it.
   *
   * Releases the recording only if this job still holds it: a replayed state
   * for a superseded job must not unlock the run that replaced it.
   */
  private settle(job: AnalysisJob): void {
    if (this.running.get(job.historyId) === job.id) this.running.delete(job.historyId);
    this.provenanceByJob.delete(job.id);
    this.deps.dataPlane.acknowledgeAnalysisState(job.id);
    this.deps.onSettled?.();
  }
}
