/**
 * Durable control-plane dispatcher for ADR-0009 TECH-04.
 *
 * Desired work lives in recording-history IndexedDB before offscreen is
 * contacted. Claims are leases and every state/result transition is fenced by
 * requestEpoch + attemptToken, so service-worker restarts and duplicate
 * execution cannot lose or publish superseded work.
 */

import { makeLogger } from '../../../shared/logger';
import type { WireAnalysis } from '../../../shared/analysis/storedAnalysis';
import type { AnalysisJob } from '../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import type { AnalysisConfig } from '../../../shared/analysis/types';
import type { TranscriptSnapshot } from '../../../shared/transcriptIdentity';
import type { RecordingAnalysisService } from './RecordingAnalysisService';
import {
  requiredAnalysisEnvironment,
  sameRequiredAnalysisEnvironment,
} from './RecordingAnalysisWork';
import {
  RecordingAnalysisWorkRepository,
  type ClaimedAnalysisWork,
} from './RecordingAnalysisWorkRepository';
import { AnalysisResultCommitter } from './AnalysisResultCommitter';

const L = makeLogger('background');
const DEFAULT_DISPATCH_BATCH = 4;
const MAX_RETRY_MS = 60_000;

export interface AnalysisDataPlane {
  ensureReady(): Promise<void>;
  analyzeTranscript(
    attemptToken: string,
    requestEpoch: number,
    historyId: string,
    transcript: TranscriptSnapshot['transcript']['segments'],
    config: AnalysisConfig,
    provenance: AnalysisProvenance,
  ): Promise<{ ok: boolean; jobId?: string; error?: string }>;
  cancelAnalysis(jobId: string): Promise<{ ok: boolean; error?: string }>;
  acknowledgeAnalysisState(jobId: string): void;
}

export type RecordingAnalysisCoordinatorDeps = {
  dataPlane: AnalysisDataPlane;
  analyses: RecordingAnalysisService;
  work: RecordingAnalysisWorkRepository;
  readTranscript: (historyId: string) => Promise<TranscriptSnapshot | undefined>;
  requestAnalysis: (
    historyId: string,
    options?: { force?: boolean },
  ) => Promise<TranscriptSnapshot | undefined>;
  isRecordingFinalized?: (historyId: string) => Promise<boolean>;
  config: () => AnalysisConfig;
  onJobChanged?: (job: AnalysisJob) => void;
  onSettled?: () => void;
  scheduleWake?: (when: number) => void;
  now?: () => number;
};

export type AnalysisStartResult =
  | { ok: true; jobId: string }
  | { ok: false; reason: 'no-transcript' | 'already-analyzed' | 'busy' | 'failed'; error?: string };

export class RecordingAnalysisCoordinator {
  private readonly resultCommitter: AnalysisResultCommitter;

  constructor(private readonly deps: RecordingAnalysisCoordinatorDeps) {
    this.resultCommitter = new AnalysisResultCommitter({
      analyses: deps.analyses,
      retry: (job, error) => this.retryAttempt(job, error),
      settle: (job) => this.settle(job),
      wake: (historyId) => { void this.wake(historyId); },
      now: deps.now,
    });
  }

  async analyze(historyId: string, options: { force?: boolean } = {}): Promise<AnalysisStartResult> {
    if (!options.force && await this.deps.analyses.get(historyId)) {
      return { ok: false, reason: 'already-analyzed' };
    }

    let transcript = await this.deps.requestAnalysis(historyId, options);
    if (!transcript?.transcript.segments.length) {
      await this.recordPreJobTerminalOutcome(
        historyId,
        'unsupported',
        'Analysis is unavailable because the recording has no transcript.',
      );
      return { ok: false, reason: 'no-transcript' };
    }

    let work = await this.deps.work.get(historyId);
    if (!work) return { ok: false, reason: 'failed', error: 'Desired analysis work was not persisted' };
    if (!options.force
      && (work.disposition === 'canceled' || work.disposition === 'unsupported' || work.disposition === 'satisfied')) {
      transcript = await this.deps.requestAnalysis(historyId, { force: true });
      work = await this.deps.work.get(historyId);
      if (!transcript || !work) return { ok: false, reason: 'failed', error: 'Could not renew analysis work' };
    }
    return await this.dispatchRecording(historyId);
  }

  /** Fast-path wake after a transcript/work transaction has already committed. */
  async wake(historyId: string): Promise<AnalysisStartResult> {
    return await this.dispatchRecording(historyId);
  }

  /** Claims and dispatches a bounded set of globally due rows. */
  async dispatchDue(limit: number = DEFAULT_DISPATCH_BATCH): Promise<number> {
    const now = this.now();
    const claims = await this.deps.work.claimDue(limit, { now });
    let dispatched = 0;
    for (const claim of claims) {
      if (this.deps.isRecordingFinalized && !await this.deps.isRecordingFinalized(claim.recordingId)) {
        await this.deps.work.releaseClaim(
          claim.recordingId,
          claim.requestEpoch,
          claim.claim.attemptToken,
        );
        continue;
      }
      await this.dispatchClaim(claim);
      dispatched += 1;
    }
    const nextAttemptAt = await this.deps.work.nextAttemptAfter(now);
    if (nextAttemptAt != null) this.deps.scheduleWake?.(nextAttemptAt);
    return dispatched;
  }

  /** Drops durable state for a deleted recording and best-effort cancels its worker. */
  async purge(historyId: string): Promise<void> {
    const work = await this.deps.work.get(historyId);
    const activeToken = work?.disposition === 'claimed' ? work.claim?.attemptToken : undefined;
    await this.deps.analyses.removeAll(historyId);
    if (activeToken) await this.deps.dataPlane.cancelAnalysis(activeToken).catch(() => {});
  }

  /** Explicitly cancels the currently claimed offscreen attempt. */
  async cancel(historyId: string): Promise<boolean> {
    const canceled = await this.deps.analyses.cancelDesired(historyId, this.now());
    if (!canceled.changed) return false;
    if (canceled.attemptToken) {
      await this.deps.dataPlane.cancelAnalysis(canceled.attemptToken).catch((error) => {
        L.warn('Durable analysis cancellation could not reach the data plane', historyId, error);
      });
    }
    return true;
  }

  async handleJobState(job: AnalysisJob): Promise<void> {
    this.deps.onJobChanged?.(job);
    if (!job.requestEpoch) {
      if (job.status !== 'analyzing') this.settle(job);
      await this.ensureCurrentAnalysis(job.historyId);
      return;
    }

    if (job.status === 'analyzing' || job.status === 'completed') {
      const committed = await this.deps.analyses.recordAttemptOutcome(
        job,
        'analyzing',
        undefined,
        undefined,
        this.now(),
      );
      if (!committed) {
        if (job.status === 'analyzing') {
          await this.deps.dataPlane.cancelAnalysis(job.id).catch(() => {});
        } else {
          this.settle(job);
        }
      }
      return;
    }

    if (job.status === 'canceled' || job.status === 'unsupported') {
      await this.deps.analyses.recordAttemptOutcome(
        job,
        job.status,
        job.error,
        { disposition: job.status, ...(job.error ? { error: job.error } : {}) },
        this.now(),
      );
      this.settle(job);
      return;
    }

    const retryAt = await this.retryAt(job);
    const committed = await this.deps.analyses.recordAttemptOutcome(
      job,
      'analyzing',
      job.error ?? (job.lostResult ? 'Completed analysis result was lost before acknowledgement.' : 'Analysis attempt failed.'),
      {
        disposition: 'retry-wait',
        nextAttemptAt: retryAt,
        ...(job.error ? { error: job.error } : {}),
      },
      this.now(),
    );
    this.settle(job);
    if (committed) this.deps.scheduleWake?.(retryAt);
  }

  async handleResult(job: AnalysisJob, wire: WireAnalysis, wireProvenance?: unknown): Promise<void> {
    await this.resultCommitter.commit(job, wire, wireProvenance);
  }

  async ensureCurrentAnalysis(historyId: string): Promise<AnalysisStartResult> {
    if (await this.deps.analyses.get(historyId)) return { ok: false, reason: 'already-analyzed' };
    const transcript = await this.deps.requestAnalysis(historyId);
    if (!transcript?.transcript.segments.length) return { ok: false, reason: 'no-transcript' };
    const work = await this.deps.work.get(historyId);
    if (work?.disposition === 'satisfied') {
      await this.deps.requestAnalysis(historyId, { force: true });
    } else if (work?.disposition === 'canceled' || work?.disposition === 'unsupported') {
      return { ok: false, reason: 'failed', ...(work.error ? { error: work.error } : {}) };
    }
    return await this.dispatchRecording(historyId);
  }

  /** Bounded full-sweep repair path retained for legacy/environment changes. */
  async reconcile(recordingIds: string[]): Promise<void> {
    for (const historyId of recordingIds) {
      if (this.deps.isRecordingFinalized && !await this.deps.isRecordingFinalized(historyId)) continue;
      const result = await this.ensureCurrentAnalysis(historyId);
      if (!result.ok && result.reason === 'failed' && result.error) {
        L.warn('Could not reconcile recording analysis', historyId, result.error);
      }
    }
    await this.dispatchDue();
  }

  private async dispatchRecording(historyId: string): Promise<AnalysisStartResult> {
    const current = await this.deps.work.get(historyId);
    if (!current) return { ok: false, reason: 'failed', error: 'No durable analysis request exists' };
    if (current.disposition === 'claimed' && (current.claim?.leaseUntil ?? 0) > this.now()) {
      return { ok: false, reason: 'busy' };
    }
    if (current.disposition === 'hash-pending') return { ok: false, reason: 'busy' };
    if (current.disposition === 'satisfied') return { ok: false, reason: 'already-analyzed' };
    if (current.disposition === 'canceled' || current.disposition === 'unsupported') {
      return { ok: false, reason: 'failed', ...(current.error ? { error: current.error } : {}) };
    }
    if ((current.nextAttemptAt ?? Number.POSITIVE_INFINITY) > this.now()) {
      this.deps.scheduleWake?.(current.nextAttemptAt!);
      return { ok: false, reason: 'busy' };
    }
    const claim = await this.deps.work.claim(historyId, { now: this.now() });
    if (!claim) return { ok: false, reason: 'busy' };
    return await this.dispatchClaim(claim);
  }

  private async dispatchClaim(claim: ClaimedAnalysisWork): Promise<AnalysisStartResult> {
    const transcript = await this.deps.readTranscript(claim.recordingId);
    const exactTranscript = transcript
      && transcript.generation === claim.transcriptGeneration
      && transcript.revision === claim.transcriptRevision
      && transcript.contentHash === claim.transcriptHash;

    if (!exactTranscript) {
      const repaired = await this.deps.requestAnalysis(claim.recordingId);
      if (!repaired) {
        await this.recordClaimTerminal(
          claim,
          'unsupported',
          'Analysis is unavailable because the requested transcript no longer exists.',
        );
        return { ok: false, reason: 'no-transcript' };
      }
      return await this.dispatchRecording(claim.recordingId);
    }

    const provenance = this.deps.analyses.provenanceForNewRun({
      generation: transcript.generation,
      revision: transcript.revision,
      contentHash: transcript.contentHash,
    });
    if (!sameRequiredAnalysisEnvironment(claim.environment, requiredAnalysisEnvironment(provenance))) {
      await this.deps.requestAnalysis(claim.recordingId);
      return await this.dispatchRecording(claim.recordingId);
    }

    try {
      await this.deps.dataPlane.ensureReady();
      const response = await this.deps.dataPlane.analyzeTranscript(
        claim.claim.attemptToken,
        claim.requestEpoch,
        claim.recordingId,
        transcript.transcript.segments,
        this.deps.config(),
        provenance,
      );
      if (!response.ok || response.jobId !== claim.claim.attemptToken) {
        const error = response.error
          ?? (response.jobId
            ? 'The data plane returned a different analysis attempt id'
            : 'The data plane refused the analysis attempt');
        await this.retryClaim(claim, error);
        return { ok: false, reason: 'failed', error };
      }
      return { ok: true, jobId: claim.claim.attemptToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      L.warn('Could not dispatch topic analysis', claim.recordingId, message);
      await this.retryClaim(claim, message);
      return { ok: false, reason: 'failed', error: message };
    }
  }

  private async retryClaim(claim: ClaimedAnalysisWork, error: string): Promise<void> {
    const retryAt = this.now() + retryDelayMs(claim.attemptCount);
    const committed = await this.deps.analyses.recordAttemptOutcome(
      jobForClaim(claim),
      'analyzing',
      error,
      { disposition: 'retry-wait', nextAttemptAt: retryAt, error },
      this.now(),
    );
    if (committed) this.deps.scheduleWake?.(retryAt);
  }

  private async retryAttempt(job: AnalysisJob, error: string): Promise<boolean> {
    if (!job.requestEpoch) return false;
    const retryAt = await this.retryAt(job);
    const committed = await this.deps.analyses.recordAttemptOutcome(
      job,
      'analyzing',
      error,
      { disposition: 'retry-wait', nextAttemptAt: retryAt, error },
      this.now(),
    );
    if (committed) this.deps.scheduleWake?.(retryAt);
    return committed;
  }

  private async retryAt(job: AnalysisJob): Promise<number> {
    const work = await this.deps.work.get(job.historyId);
    return this.now() + retryDelayMs(work?.attemptCount ?? 1);
  }

  private async recordClaimTerminal(
    claim: ClaimedAnalysisWork,
    status: 'canceled' | 'unsupported',
    error?: string,
  ): Promise<void> {
    await this.deps.analyses.recordAttemptOutcome(
      jobForClaim(claim),
      status,
      error,
      { disposition: status, ...(error ? { error } : {}) },
      this.now(),
    );
  }

  private async recordPreJobTerminalOutcome(
    historyId: string,
    status: 'failed' | 'unsupported',
    error: string,
  ): Promise<void> {
    try {
      const now = this.now();
      await this.deps.analyses.recordTerminalOutcome(historyId, status, error, now, now);
    } catch (cause) {
      L.warn('Could not persist pre-job analysis outcome', historyId, cause);
    }
  }

  private settle(job: AnalysisJob): void {
    this.deps.dataPlane.acknowledgeAnalysisState(job.id);
    this.deps.onSettled?.();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function jobForClaim(claim: ClaimedAnalysisWork): AnalysisJob {
  return {
    id: claim.claim.attemptToken,
    requestEpoch: claim.requestEpoch,
    historyId: claim.recordingId,
    status: 'analyzing',
    progress: 0,
    startedAt: claim.claim.claimedAt,
  };
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(6, attemptCount - 1));
  return Math.min(MAX_RETRY_MS, 1_000 * (2 ** exponent));
}
