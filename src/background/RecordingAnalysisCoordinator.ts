/**
 * @file background/RecordingAnalysisCoordinator.ts
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
 */

import { makeLogger } from '../shared/logger';
import { fromWireAnalysis, type WireAnalysis } from '../shared/analysis/storedAnalysis';
import type { AnalysisJob } from '../shared/analysis/job';
import type { AnalysisProvenance } from '../shared/analysis/provenance';
import type { AnalysisConfig } from '../shared/analysis/types';
import type { Transcript } from '../shared/transcript';
import type { RecordingAnalysisService } from './RecordingAnalysisService';

const L = makeLogger('background');

/** The offscreen surface this needs, narrowed so tests need no port. */
export interface AnalysisDataPlane {
  ensureReady(): Promise<void>;
  analyzeTranscript(
    historyId: string,
    transcript: Transcript['segments'],
    config: AnalysisConfig,
  ): Promise<{ ok: boolean; jobId?: string; error?: string }>;
  cancelAnalysis(jobId: string): Promise<{ ok: boolean; error?: string }>;
  acknowledgeAnalysisState(jobId: string): void;
}

export type RecordingAnalysisCoordinatorDeps = {
  dataPlane: AnalysisDataPlane;
  analyses: RecordingAnalysisService;
  /** Reads a recording's persisted transcript; `undefined` when it has none. */
  readTranscript: (historyId: string) => Promise<Transcript | undefined>;
  /** The §9 values a run should use. Injected so a later settings surface can supply them. */
  config: () => AnalysisConfig;
  /** Notified whenever a job moves, for the surface. */
  onJobChanged?: (job: AnalysisJob) => void;
  now?: () => number;
};

/** Why a requested analysis did not start. */
export type AnalysisStartResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'no-transcript' | 'already-analyzed' | 'busy' | 'failed'; error?: string };

export class RecordingAnalysisCoordinator {
  private readonly running = new Map<string, string>();
  /** Recordings deleted while an analysis was in flight; see {@link purge}. */
  private readonly purged = new Set<string>();
  /**
   * The conditions each in-flight job was enqueued under, keyed by job id.
   *
   * Provenance has to describe the run that produced a result, not the moment
   * it happened to be written, so it is captured at enqueue and carried here
   * until the result comes back. A job whose entry is missing — because the
   * service worker restarted mid-run — falls back to current conditions, which
   * is the same guess the old code always made and is no worse.
   */
  private readonly provenanceByJob = new Map<string, AnalysisProvenance>();

  constructor(private readonly deps: RecordingAnalysisCoordinatorDeps) {}

  /**
   * Starts analysis for one recording, unless there is nothing to analyse or a
   * current result already exists.
   *
   * `force` skips the freshness check — the recompute path for a changed
   * configuration, where the caller has already decided the stored result is
   * not the one it wants.
   */
  async analyze(historyId: string, options: { force?: boolean } = {}): Promise<AnalysisStartResult> {
    if (this.running.has(historyId)) {
      return { ok: false, reason: 'busy' };
    }
    if (!options.force && await this.deps.analyses.get(historyId)) {
      // INC-03: results are computed once and never recomputed on reopen.
      return { ok: false, reason: 'already-analyzed' };
    }

    const transcript = await this.deps.readTranscript(historyId);
    if (!transcript?.segments.length) return { ok: false, reason: 'no-transcript' };

    // Reaching here means the recording exists and has words, so an earlier
    // deletion marker is stale — the id has been reused or the recording came
    // back. Either way a fresh run's result is wanted.
    this.purged.delete(historyId);

    // Captured before the run starts, not when its result lands.
    const provenance = this.deps.analyses.provenanceForNewRun();
    try {
      await this.deps.dataPlane.ensureReady();
      const response = await this.deps.dataPlane.analyzeTranscript(
        historyId,
        transcript.segments,
        this.deps.config(),
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
    }
  }

  /**
   * Drops a deleted recording's analysis, and makes sure a late one cannot
   * resurrect it.
   *
   * Three things in order, because the race is real: a run started before the
   * deletion can finish afterwards and deliver a result for a recording that no
   * longer exists.
   *
   *  1. mark the recording purged, so a result arriving later is discarded
   *     rather than stored,
   *  2. cancel any job still running, so the data plane stops paying for work
   *     nobody wants, and
   *  3. remove whatever is already on disk.
   *
   * The marker is kept rather than cleared on cancel, because cancellation is
   * asynchronous — the job stops at its next batch boundary, and a job that had
   * already finished computing will still deliver. It is cleared when the same
   * recording is analysed again, which can only happen if it exists.
   */
  async purge(historyId: string): Promise<void> {
    this.purged.add(historyId);
    await this.cancel(historyId).catch(() => {});
    this.running.delete(historyId);
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
   * Terminal states clear the per-recording lock here rather than on delivery:
   * a job that failed or was canceled never delivers anything, and leaving it
   * locked would make the recording permanently un-analysable.
   */
  handleJobState(job: AnalysisJob): void {
    if (job.status === 'analyzing') this.running.set(job.historyId, job.id);
    else if (this.running.get(job.historyId) === job.id) this.running.delete(job.historyId);
    this.deps.onJobChanged?.(job);

    // A job that ends without a result has nothing left to wait for, so its
    // outbox row is released here. Only `completed` defers its acknowledgement
    // to `handleResult`, which waits until the analysis is actually on disk.
    //
    // Without this, a failed or cancelled run leaves an `analysisJobState:` key
    // behind that is replayed on every reconnect for the life of the profile —
    // the outbox is drained by acknowledgement and by nothing else.
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'unsupported') {
      this.provenanceByJob.delete(job.id);
      this.deps.dataPlane.acknowledgeAnalysisState(job.id);
    }
  }

  /**
   * Persists a completed analysis and acknowledges it.
   *
   * A damaged payload is dropped *and still acknowledged*: the data plane
   * cannot fix it by resending, so leaving it held would replay the same
   * corrupt message on every reconnect forever. The recording simply reads as
   * un-analysed and can be run again.
   */
  async handleResult(job: AnalysisJob, wire: WireAnalysis): Promise<void> {
    if (this.purged.has(job.historyId)) {
      // The recording was deleted while this was computing. Acknowledged so the
      // data plane stops holding it, and deliberately not stored: writing it
      // would leave a row for a recording nothing will ever delete again.
      L.log(`Discarding an analysis for deleted recording ${job.historyId}`);
      this.provenanceByJob.delete(job.id);
      this.deps.dataPlane.acknowledgeAnalysisState(job.id);
      return;
    }

    const result = fromWireAnalysis(wire);
    if (!result) {
      L.warn('Discarding an incoherent analysis result', job.historyId, job.id);
      this.provenanceByJob.delete(job.id);
      this.deps.dataPlane.acknowledgeAnalysisState(job.id);
      return;
    }

    const provenance = this.provenanceByJob.get(job.id) ?? this.deps.analyses.provenanceForNewRun();
    try {
      await this.deps.analyses.save(job.historyId, result, provenance, this.deps.now?.());
    } catch (error) {
      if (!isQuotaExceeded(error)) {
        // Transient — a transaction aborted under another write, say. Hold the
        // ack so the data plane re-offers the result on the next reconnect.
        L.warn('Could not store an analysis result', job.historyId, error);
        return;
      }
      // Out of space, which retrying cannot fix. Acknowledge anyway: holding
      // would pin a few megabytes of vectors in the offscreen document for the
      // rest of the session and re-offer them on every reconnect, forever.
      //
      // Affordable precisely because an analysis is *derived* — the transcript
      // is still there, so the recording simply reads as un-analysed and can be
      // run again once the user frees space. Upload bytes could never be
      // dropped this way, which is why they are not.
      L.warn(
        `Discarding the analysis for ${job.historyId}: storage is full. `
        + 'The recording is unaffected and can be analysed again after freeing space.',
      );
      this.provenanceByJob.delete(job.id);
      this.deps.dataPlane.acknowledgeAnalysisState(job.id);
      return;
    }
    this.provenanceByJob.delete(job.id);
    this.deps.dataPlane.acknowledgeAnalysisState(job.id);
  }
}

/**
 * Whether a storage failure was "no space left" rather than something a retry
 * could clear.
 *
 * Checked by `name` rather than `instanceof DOMException`: the value that
 * reaches here has crossed a repository boundary and, in the test harness, is
 * not always a real `DOMException`. The name is the part every implementation
 * agrees on.
 */
function isQuotaExceeded(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
