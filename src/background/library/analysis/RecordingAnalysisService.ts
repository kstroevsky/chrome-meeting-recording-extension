/**
 * Owns analysis transitions and decides whether stored output still matches
 * the current transcript, pipeline, model, and configuration.
 */

import type { AnalysisJob, AnalysisJobStatus } from '../../../shared/analysis/job';
import {
  type AnalysisEnvironmentProvenance,
  type AnalysisProvenance,
} from '../../../shared/analysis/provenance';
import type { TranscriptIdentity } from '../../../shared/transcriptIdentity';
import {
  type RecordingTopicSummary,
  type StoredAnalysis,
} from '../../../shared/analysis/storedAnalysis';
import type {
  AnalysisAttemptTransition,
  RecordingAnalysisRepositoryPort,
} from './RecordingAnalysisRepository';
import type { RecordingAnalysisOutcome } from './RecordingAnalysisOutcome';
import {
  RecordingAnalysisReader,
  type AnalysisExportState,
  type AnalysisState,
} from './RecordingAnalysisReader';

export type { AnalysisExportState, AnalysisState } from './RecordingAnalysisReader';

export class RecordingAnalysisService {
  private readonly reader: RecordingAnalysisReader;

  constructor(
    private readonly repository: RecordingAnalysisRepositoryPort,
    /** The conditions a fresh run would use; compared against what is stored. */
    currentEnvironment: () => AnalysisEnvironmentProvenance | AnalysisProvenance,
    readTranscriptIdentity?: (recordingId: string) => Promise<TranscriptIdentity | undefined>,
    private readonly onChanged?: (recordingId: string) => void,
  ) {
    this.reader = new RecordingAnalysisReader(repository, currentEnvironment, readTranscriptIdentity);
  }

  /**
   * The stored analysis, or `undefined` when there is none **or it is stale**.
   *
   * Stale is folded into "nothing to show" deliberately: a caller that only
   * wants topics should not have to know why there are none, and one that
   * cares can ask {@link state}.
   */
  async get(recordingId: string): Promise<StoredAnalysis | undefined> {
    return await this.reader.get(recordingId);
  }

  /** What a surface should render, including *why* there is nothing to render. */
  async state(recordingId: string): Promise<AnalysisState> {
    return await this.reader.state(recordingId);
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
    return await this.reader.exportState(recordingId);
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
    this.onChanged?.(job.historyId);
  }

  /** Persists state only if this job still owns the durable desired-work claim. */
  async recordAttemptOutcome(
    job: AnalysisJob,
    status: AnalysisJobStatus = job.status,
    error: string | undefined = job.error,
    transition?: AnalysisAttemptTransition,
    now: number = Date.now(),
  ): Promise<boolean> {
    const outcome: RecordingAnalysisOutcome = {
      status,
      jobId: job.id,
      startedAt: job.startedAt,
      updatedAt: now,
      ...(error ? { error } : {}),
    };
    const committed = await this.repository.putAttemptOutcome(job.historyId, job, outcome, transition);
    if (committed) this.onChanged?.(job.historyId);
    return committed;
  }

  /** Persists a terminal attempt that ended before the data plane created a job. */
  async recordTerminalOutcome(
    recordingId: string,
    status: Extract<AnalysisJobStatus, 'failed' | 'canceled' | 'unsupported'>,
    error: string | undefined,
    startedAt: number = Date.now(),
    updatedAt: number = Date.now(),
  ): Promise<void> {
    const outcome: RecordingAnalysisOutcome = {
      status,
      startedAt,
      updatedAt,
      ...(error ? { error } : {}),
    };
    await this.repository.putOutcome(recordingId, outcome);
    this.onChanged?.(recordingId);
  }

  /**
   * The conditions a run starting now would use. Captured at **enqueue** and
   * carried with the job, so what is stored describes the run that actually
   * produced those vectors.
   */
  provenanceForNewRun(transcript?: TranscriptIdentity): AnalysisProvenance {
    return this.reader.provenanceForNewRun(transcript);
  }

  async isCurrent(recordingId: string, provenance: AnalysisProvenance): Promise<boolean> {
    return await this.reader.isCurrent(recordingId, provenance);
  }

  /** Checks only transcript identity; other provenance may legitimately become stale mid-run. */
  async isCurrentTranscript(recordingId: string, provenance: AnalysisProvenance): Promise<boolean> {
    return await this.reader.isCurrentTranscript(recordingId, provenance);
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
    this.onChanged?.(recordingId);
    return analysis;
  }

  /** Publishes only if transcript, environment, epoch and attempt token still match. */
  async saveAttempt(
    recordingId: string,
    result: Omit<StoredAnalysis, 'provenance' | 'completedAt'>,
    provenance: AnalysisProvenance,
    job: AnalysisJob,
    now: number = Date.now(),
  ): Promise<{ analysis: StoredAnalysis; committed: boolean }> {
    const analysis: StoredAnalysis = { ...result, provenance, completedAt: now };
    const outcome: RecordingAnalysisOutcome = {
      status: 'completed',
      jobId: job.id,
      startedAt: job.startedAt,
      updatedAt: now,
    };
    const committed = await this.repository.publishAttemptResult(
      recordingId,
      job,
      analysis,
      outcome,
      provenance,
    );
    if (committed) this.onChanged?.(recordingId);
    return { analysis, committed };
  }

  /** Cancels durable desired work before the data-plane cancellation is attempted. */
  async cancelDesired(
    recordingId: string,
    now: number = Date.now(),
  ): Promise<{ changed: boolean; attemptToken?: string }> {
    const result = await this.repository.cancelDesired(recordingId, now);
    if (result.changed) this.onChanged?.(recordingId);
    return result;
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
    return await this.reader.topicSummaries(recordingIds);
  }

  /** Drops a recording's analysis — a discarded run, a deleted entry, or a recompute. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.removeAll(recordingId);
  }
}
