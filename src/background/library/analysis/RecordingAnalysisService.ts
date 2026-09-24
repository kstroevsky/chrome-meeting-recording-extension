/**
 * @file background/library/analysis/RecordingAnalysisService.ts
 *
 * Owns every analysis transition, and decides when a stored one still counts.
 *
 * The interesting behaviour here is not storage, it is **staleness**. Four of
 * the scoring terms are provisional, every §9 value is still a candidate rather
 * than a frozen contract, and the embedding model and its quantization may
 * change. A stored analysis is therefore only meaningful alongside the
 * conditions that produced it, and this is the layer that compares them.
 */

import type { AnalysisJob, AnalysisJobStatus } from '../../../shared/analysis/job';
import { isStale, type AnalysisProvenance } from '../../../shared/analysis/provenance';
import {
  summarize,
  toTopicSummary,
  type AnalysisSummary,
  type RecordingTopicSummary,
  type StoredAnalysis,
} from '../../../shared/analysis/storedAnalysis';
import type { RecordingAnalysisRepositoryPort } from './RecordingAnalysisRepository';
import type { RecordingAnalysisOutcome } from './RecordingAnalysisOutcome';

/** Why a recording has no usable analysis, or that it has one. */
export type AnalysisState =
  | { status: 'ready'; summary: AnalysisSummary }
  /** Never analysed. */
  | { status: 'none' }
  /** Analysed under conditions that no longer apply; recompute to replace it. */
  | { status: 'stale' };

/** Library-owned state for consumers that must distinguish waiting from terminal unavailability. */
export type AnalysisExportState =
  | { status: 'none' }
  | { status: 'analyzing'; error?: string }
  | { status: 'completed'; result: StoredAnalysis }
  | { status: 'failed' | 'canceled' | 'unsupported'; error?: string }
  | { status: 'stale'; error: string };

export class RecordingAnalysisService {
  constructor(
    private readonly repository: RecordingAnalysisRepositoryPort,
    /** The conditions a fresh run would use; compared against what is stored. */
    private readonly currentProvenance: () => AnalysisProvenance,
  ) {}

  /**
   * The stored analysis, or `undefined` when there is none **or it is stale**.
   *
   * Stale is folded into "nothing to show" deliberately: a caller that only
   * wants topics should not have to know why there are none, and one that
   * cares can ask {@link state}.
   */
  async get(recordingId: string): Promise<StoredAnalysis | undefined> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return undefined;
    return isStale(stored.provenance, this.currentProvenance()) ? undefined : stored;
  }

  /** What a surface should render, including *why* there is nothing to render. */
  async state(recordingId: string): Promise<AnalysisState> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return { status: 'none' };
    if (isStale(stored.provenance, this.currentProvenance())) return { status: 'stale' };
    return { status: 'ready', summary: summarize(stored) };
  }

  /**
   * Durable readiness seam for integrations and future automation.
   *
   * A current result wins over job bookkeeping. Otherwise active work remains
   * pending, terminal job outcomes remain terminal after their offscreen rows
   * are acknowledged, and a stale result is explicitly terminal-unavailable
   * until somebody starts a recomputation.
   */
  async exportState(recordingId: string): Promise<AnalysisExportState> {
    const { analysis, outcome } = await this.repository.getSnapshot(recordingId);
    if (analysis && !isStale(analysis.provenance, this.currentProvenance())) {
      return { status: 'completed', result: analysis };
    }

    if (outcome?.status === 'analyzing') {
      return { status: 'analyzing', ...(outcome.error ? { error: outcome.error } : {}) };
    }
    if (outcome && (outcome.status === 'failed' || outcome.status === 'canceled' || outcome.status === 'unsupported')) {
      return { status: outcome.status, ...(outcome.error ? { error: outcome.error } : {}) };
    }
    if (analysis) {
      return {
        status: 'stale',
        error: 'Stored analysis is stale and must be recomputed before it can be exported.',
      };
    }
    if (outcome?.status === 'completed') {
      return {
        status: 'failed',
        error: 'Analysis completed, but its stored result is unavailable.',
      };
    }
    return { status: 'none' };
  }

  /** Persists a job state before its offscreen outbox row may be acknowledged. */
  async recordJobOutcome(
    job: AnalysisJob,
    status: AnalysisJobStatus = job.status,
    error: string | undefined = job.error,
    now: number = Date.now(),
  ): Promise<void> {
    const outcome: RecordingAnalysisOutcome = {
      status,
      jobId: job.id,
      startedAt: job.startedAt,
      // Receipt order is the control-plane ordering we can trust. `finishedAt`
      // can precede a previously received running update after reconnect/replay.
      updatedAt: now,
      ...(error ? { error } : {}),
    };
    await this.repository.putOutcome(job.historyId, outcome);
  }

  /**
   * The conditions a run starting now would use. Captured at **enqueue** and
   * carried with the job, so what is stored describes the run that actually
   * produced those vectors.
   */
  provenanceForNewRun(): AnalysisProvenance {
    return this.currentProvenance();
  }

  /**
   * Stores a completed analysis under the conditions it **ran** under.
   *
   * `provenance` is the caller's, and must be the value captured when the run
   * was enqueued. Stamping `currentProvenance()` here instead — which this used
   * to do — records what is true at *persistence* time, which is a different
   * claim: a configuration or model change between enqueue and save would make
   * the row assert conditions that never produced it, and it would then read as
   * current when it is not.
   *
   * The two coincide whenever nothing changes mid-run, which is why the bug was
   * invisible; they stop coinciding exactly when staleness starts to matter.
   */
  async save(
    recordingId: string,
    result: Omit<StoredAnalysis, 'provenance' | 'completedAt'>,
    provenance: AnalysisProvenance,
    now: number = Date.now(),
    job?: Pick<AnalysisJob, 'id' | 'startedAt'>,
  ): Promise<StoredAnalysis> {
    const analysis: StoredAnalysis = { ...result, provenance, completedAt: now };
    const outcome: RecordingAnalysisOutcome = {
      status: 'completed',
      ...(job ? { jobId: job.id } : {}),
      startedAt: job?.startedAt ?? now,
      updatedAt: now,
    };
    await this.repository.putCompleted(recordingId, analysis, outcome);
    return analysis;
  }

  /**
   * Topic digests for a page of the library, keyed by recording id.
   *
   * Recordings with no current analysis are simply absent from the result
   * rather than present with empty keywords — the column renders nothing either
   * way, and a caller can tell "not analysed" from "analysed, no topics".
   *
   * One read per recording, which is what the underlying store supports; the
   * page size is a screenful, and this is a fire-and-forget digest the table
   * does not wait for.
   */
  async topicSummaries(recordingIds: string[]): Promise<Record<string, RecordingTopicSummary>> {
    const current = this.currentProvenance();
    const summaries: Record<string, RecordingTopicSummary> = {};
    for (const recordingId of recordingIds) {
      const stored = await this.repository.get(recordingId);
      if (!stored || isStale(stored.provenance, current)) continue;
      summaries[recordingId] = toTopicSummary(stored);
    }
    return summaries;
  }

  /** Drops a recording's analysis — a discarded run, a deleted entry, or a recompute. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.removeAll(recordingId);
  }
}
